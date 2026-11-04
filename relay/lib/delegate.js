'use strict';
// Delegation (scope `answer`, "Answer for me"): a teammate answers a Needs-you item for the
// captain. The relay only stores and checks; the captain's deck sends it (at once when the captain
// asked that teammate for help, else after a 5 s window the captain can cancel). Pure functions;
// lib/app.js checks grants, stores, rate-limits, audits and routes.
//   ans:<captainSub>   hash: <id> -> one answer (24 h)
//   ansv:<captainSub>  bumped on every change, read in the deck auth MGET
//   ansr:<captainSub>:<viewerSub>:<hour>  per-viewer rate counter
//   hlp:<captainSub>   hash: <id> -> one help request (24 h)
//   hlpv:<email>       bumped when that teammate's help requests change (read in the viewer's board MGET)
const { randomId } = require('../auth/tokens');

const TTL = 86400;
const MAX_TEXT = 1000;
const PER_DECK = 20; // pending answers per deck
const PER_HOUR = 20; // answers per viewer per deck per hour
const HELP_PER_DECK = 30; // open help requests per deck
const REF_RE = /^[A-Za-z0-9_-]{8,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
const ANSWER_STATES = ['pending', 'sent', 'cancelled', 'refused'];
const ASKING = ['needs-decision', 'blocked', 'failed'];
// The deck says it can take answers (old decks never send it, so their mates are refused).
const FEATURE = 'answer';

// Text a teammate typed: tags and control characters out (newlines kept, at most two in a row), capped.
function cleanText(v, max = MAX_TEXT) {
  if (typeof v !== 'string') return '';
  return v.replace(/<\/?[A-Za-z!?][^>]*>/g, '')
    .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim().slice(0, max);
}

// A viewer's body -> { ref, letter, text } (or throws). A letter, a reply, or both.
function sanitizeAnswer(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.ref !== 'string' || !REF_RE.test(b.ref)) throw new Error('bad item');
  const letter = typeof b.letter === 'string' ? b.letter.trim().toUpperCase() : '';
  if (letter && !/^[A-H]$/.test(letter)) throw new Error('pick one of the options');
  const text = cleanText(b.text);
  if (!letter && !text) throw new Error('pick an option or write a reply');
  return { ref: b.ref, letter: letter || null, text };
}

// The deck's help request body -> { ref, email } (or throws).
function sanitizeHelp(body, normalizeEmail) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.ref !== 'string' || !REF_RE.test(b.ref)) throw new Error('bad item');
  const email = normalizeEmail(typeof b.email === 'string' ? b.email : '');
  if (!email) throw new Error('bad email');
  return { ref: b.ref, email };
}

// Why this item cannot be answered by a teammate, or null.
function refusal(target, letter) {
  if (!target) return 'item not found';
  if (target.guarded) return 'only the captain can answer this';
  if (target.kind === 'worker' && !ASKING.includes(target.state)) return 'it no longer needs an answer';
  if (letter && !(target.options || []).some((o) => o.letter === letter)) return 'that option is not on the current decision';
  return null;
}

// "B", "a reply" or "B and a reply" (for audit rows).
const describe = (x) => [x.letter, x.text ? 'a reply' : null].filter(Boolean).join(' and ');

const fieldsOf = (raw) => {
  const fields = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) fields[raw[i]] = raw[i + 1];
  else Object.assign(fields, raw || {});
  return fields;
};
// HGETALL -> live records (younger than TTL), oldest first.
function readAll(raw, now) {
  const out = [];
  for (const v of Object.values(fieldsOf(raw))) {
    let s;
    try { s = JSON.parse(v); } catch { continue; }
    if (s && ID_RE.test(s.id) && s.at > now - TTL * 1000) out.push(s);
  }
  return out.sort((a, b) => a.at - b.at);
}
function expired(raw, now) {
  const live = new Set(readAll(raw, now).map((s) => s.id));
  return Object.keys(fieldsOf(raw)).filter((id) => !live.has(id));
}

const newId = () => randomId(9);

module.exports = { TTL, MAX_TEXT, PER_DECK, PER_HOUR, HELP_PER_DECK, ID_RE, ANSWER_STATES, ASKING, FEATURE, cleanText, sanitizeAnswer, sanitizeHelp, refusal, describe, readAll, expired, newId };
