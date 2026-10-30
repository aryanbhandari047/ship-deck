'use strict';
// Usage counts of shared knowledge: how often a teammate's agent used a captain's shared skill (or
// their notes), reported by the teammate's own deck. Counts and times only, never text. Pure
// functions; lib/app.js checks grants, stores and audits.
//   use:<captainSub>  Redis hash: "c\t<key>\t<email>" count, "l\t<key>\t<email>" last use (ms)
const { KEY_RE } = require('./library');

const NOTES_KEY = 'notes'; // the teammate's deck merges all notes into one skill
const MAX_ITEMS = 200;
const MAX_COUNT = 10000; // per item per report
const MAX_BODY = 32 * 1024;
const TTL = 90 * 86400; // like the audit log
const SUB_RE = /^[A-Za-z0-9_-]{8,40}$/;

// A report body -> [{ captainSub, key, count, last }] (or throws on a shape a deck never sends).
// Duplicates add up; last is clamped to the past 90 days.
function sanitizeReport(body, now) {
  if (!body || typeof body !== 'object' || body.v !== 1 || !Array.isArray(body.items)) throw new Error('unsupported usage report');
  const out = new Map();
  for (const x of body.items.slice(0, MAX_ITEMS)) {
    if (!x || typeof x !== 'object' || !SUB_RE.test(x.captainSub) || typeof x.key !== 'string') continue;
    if (x.key !== NOTES_KEY && !KEY_RE.test(x.key)) continue;
    const count = Math.floor(Number(x.count));
    if (!(count >= 1)) continue;
    const last = Math.min(now, Math.max(now - TTL * 1000, Number(x.last) || now));
    const id = x.captainSub + '\t' + x.key;
    const prev = out.get(id);
    if (prev) Object.assign(prev, { count: Math.min(MAX_COUNT, prev.count + count), last: Math.max(prev.last, last) });
    else out.set(id, { captainSub: x.captainSub, key: x.key, count: Math.min(MAX_COUNT, count), last });
  }
  return [...out.values()];
}

// Commands that add these items for one viewer to the captain's counts.
function writeCmds(captainSub, email, items) {
  const k = 'use:' + captainSub;
  const cmds = [];
  for (const it of items) {
    cmds.push(['HINCRBY', k, `c\t${it.key}\t${email}`, it.count], ['HSET', k, `l\t${it.key}\t${email}`, String(it.last)]);
  }
  cmds.push(['EXPIRE', k, TTL]);
  return cmds;
}

// HGETALL (a flat list or an object) -> [{ key, viewerEmail, count, last }], most used first.
function readRows(raw, now) {
  const fields = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) fields[raw[i]] = raw[i + 1];
  else Object.assign(fields, raw || {});
  const rows = [];
  for (const [f, v] of Object.entries(fields)) {
    const [t, key, email] = f.split('\t');
    if (t !== 'c' || !key || !email) continue;
    const last = Number(fields[`l\t${key}\t${email}`]) || null;
    if (last && last < now - TTL * 1000) continue;
    rows.push({ key, viewerEmail: email, count: Number(v) || 0, last });
  }
  return rows.sort((a, b) => b.count - a.count || (b.last || 0) - (a.last || 0));
}

module.exports = { NOTES_KEY, MAX_ITEMS, MAX_COUNT, MAX_BODY, TTL, sanitizeReport, writeCmds, readRows };
