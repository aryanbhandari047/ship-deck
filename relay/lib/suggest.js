'use strict';
// Live pairing: a viewer with the `suggest` scope suggests an option letter (plus a note the
// captain sees but that is never sent) for a worker waiting on a decision. The captain's deck
// shows it as data; it reaches an agent only through the captain's own send. Pure functions;
// lib/app.js checks grants, stores, rate-limits, audits and routes.
//   sug:<captainSub>   Redis hash: <id> -> one suggestion (24 h)
//   sugv:<captainSub>  bumped on every change, read in the deck auth MGET (decks fetch on change)
//   sugr:<captainSub>:<viewerSub>:<hour>  per-viewer rate counter
const { randomId } = require('../auth/tokens');

const TTL = 86400;
const MAX_NOTE = 300;
const PER_VIEWER = 5; // pending per viewer per deck
const PER_DECK = 20; // pending per deck
const PER_HOUR = 10; // new suggestions per viewer per deck per hour
const REF_RE = /^[A-Za-z0-9_-]{8,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
const STATES = ['pending', 'used', 'dismissed'];
const ASKING = ['needs-decision', 'blocked'];

// A viewer's body -> { ref, letter, note } (or throws).
function sanitize(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.ref !== 'string' || !REF_RE.test(b.ref)) throw new Error('bad worker');
  const letter = typeof b.letter === 'string' ? b.letter.trim().toUpperCase() : '';
  if (!/^[A-H]$/.test(letter)) throw new Error('pick one of the options');
  const note = typeof b.note === 'string' ? b.note.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
  return { ref: b.ref, letter, note };
}

const fieldsOf = (raw) => {
  const fields = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) fields[raw[i]] = raw[i + 1];
  else Object.assign(fields, raw || {});
  return fields;
};
// HGETALL (a flat list or an object) -> live suggestions (younger than TTL), oldest first.
function readAll(raw, now) {
  const fields = fieldsOf(raw);
  const out = [];
  for (const v of Object.values(fields)) {
    let s;
    try { s = JSON.parse(v); } catch { continue; }
    if (s && ID_RE.test(s.id) && s.at > now - TTL * 1000) out.push(s);
  }
  return out.sort((a, b) => a.at - b.at);
}

// Field names in that hash that are no longer live (pruned on the next write).
function expired(raw, now) {
  const live = new Set(readAll(raw, now).map((s) => s.id));
  return Object.keys(fieldsOf(raw)).filter((id) => !live.has(id));
}

const newId = () => randomId(9);

module.exports = { TTL, MAX_NOTE, PER_VIEWER, PER_DECK, PER_HOUR, ID_RE, STATES, ASKING, sanitize, readAll, expired, newId };
