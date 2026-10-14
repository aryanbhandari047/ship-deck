'use strict';
// Agent library access (grant scope agentLibrary): the pushed library projection and read-only
// agent keys. Pure functions; lib/app.js stores and routes. The deck builds and redacts the
// projection (lib/share.js projectLibrary); this file re-applies the same allow-list.
//   lib:<captainSub>   Redis hash: field "index" (JSON list without text), field "i:<key>" per item
//   agk:<sha256(key)>  one agent key record   agks:<captainSub>:<viewerSub>  that viewer's key ids
const { randomId, sha256 } = require('../auth/tokens');

const ITEM_KEYS = ['key', 'title', 'description', 'text'];
const KEY_RE = /^(?:skill|memory|home):[A-Za-z0-9_.:/-]{1,110}$/;
const MAX_ITEMS = 150;
const MAX_TEXT = 16000;
const MAX_BYTES = 256 * 1024;
const LIB_TTL = 2 * 3600; // the deck re-pushes hourly; paused or offline decks drop out within 2 h
const MAX_KEYS = 3; // per viewer per deck
const KEY_TTL = 30 * 86400; // a grant lasts at most 30 days; the key is also checked against it
const RATE_PER_HOUR = 60;
const TOKEN_RE = /^sdak1\.([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{43})$/;

const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const kindOf = (key) => (key.startsWith('skill:') ? 'skill' : 'note');

// A pushed body -> { index, items } (or throws on a shape the deck never sends).
function sanitizeLibrary(body) {
  if (!body || typeof body !== 'object' || body.v !== 1 || !Array.isArray(body.items)) throw new Error('unsupported library');
  const seen = new Set();
  const items = [];
  for (const x of body.items.slice(0, MAX_ITEMS)) {
    if (!x || typeof x !== 'object' || typeof x.key !== 'string' || !KEY_RE.test(x.key) || seen.has(x.key)) continue;
    seen.add(x.key);
    items.push({ key: x.key, kind: kindOf(x.key), title: s(x.title, 120) || x.key, description: s(x.description, 300), text: s(x.text, MAX_TEXT) });
  }
  const index = items.map(({ text, ...rest }) => ({ ...rest, size: Buffer.byteLength(text) }));
  return { index, items, trimmed: Number.isInteger(body.trimmed) && body.trimmed > 0 ? Math.min(body.trimmed, 1000) : 0 };
}

// What a grant lets an agent read: skills always, notes and memory only with the notes scope.
const notesAllowed = (grant) => !!grant && grant.scopes.includes('notes');
const itemAllowed = (key, grant) => kindOf(key) === 'skill' || notesAllowed(grant);

// "sdak1.<captainSub>.<random>": the deck it reads is in the key, so a read is one round trip.
function newKey(captainSub) {
  const token = `sdak1.${captainSub}.${randomId(32)}`;
  return { token, hash: sha256(token), id: randomId(6) };
}
function parseKey(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  return m ? { captainSub: m[1], hash: sha256(m[0]) } : null;
}

// A key label from the viewer: printable, one line, 1-40 characters.
function cleanLabel(v) {
  const t = String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return t || 'Agent key';
}

// The key's end: its own 30 days or the grant's end, whichever is first.
const keyExpiry = (rec, grant) => Math.min(rec.createdAt + KEY_TTL * 1000, grant ? grant.expiresAt : 0);

// Hour bucket for the per-key rate limit, and the seconds left in it.
function rateWindow(now) {
  const bucket = Math.floor(now / 3600e3);
  return { bucket, retryAfter: Math.max(1, Math.ceil(((bucket + 1) * 3600e3 - now) / 1000)) };
}

const fieldOf = (key) => 'i:' + key;

module.exports = {
  ITEM_KEYS, KEY_RE, MAX_ITEMS, MAX_TEXT, MAX_BYTES, LIB_TTL, MAX_KEYS, KEY_TTL, RATE_PER_HOUR, TOKEN_RE,
  kindOf, sanitizeLibrary, notesAllowed, itemAllowed, newKey, parseKey, cleanLabel, keyExpiry, rateWindow, fieldOf,
};
