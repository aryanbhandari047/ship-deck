'use strict';
// Shared knowledge: the library a captain pushes (granted skills and notes, full text) that a
// teammate's own Ship Deck syncs into their agent's skills, plus the optional read-only agent keys
// for agents without Ship Deck. Pure functions; lib/app.js stores and routes. The deck builds and
// redacts the projection (lib/share.js projectLibrary); this file re-applies the same allow-list.
//   lib:<captainSub>   Redis hash: field "index" (JSON list without text), field "i:<key>" per item
//   agk:<sha256(key)>  one agent key record   agks:<captainSub>:<viewerSub>  that viewer's key ids
const { randomId, sha256 } = require('../auth/tokens');

// updatedAt/verifiedAt: when the captain last changed or checked it; tag 'share': a note marked
// for grants that carry only marked notes (private notes never leave the deck).
const ITEM_KEYS = ['key', 'title', 'description', 'text', 'updatedAt', 'verifiedAt', 'tag'];
const KEY_RE = /^(?:skill|memory|home):[A-Za-z0-9_.:/-]{1,110}$/;
const MAX_ITEMS = 150;
const MAX_TEXT = 16000;
const MAX_BYTES = 512 * 1024; // the deck caps its push at the same (lib/share.js LIMITS.library)
const LIB_TTL = 2 * 3600; // the deck re-pushes hourly; paused or offline decks drop out within 2 h
const MAX_KEYS = 3; // per viewer per deck
const KEY_TTL = 30 * 86400; // a grant lasts at most 30 days; the key is also checked against it
const RATE_PER_HOUR = 60;
const TOKEN_RE = /^sdak1\.([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{43})$/;

const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const kindOf = (key) => (key.startsWith('skill:') ? 'skill' : 'note');

// A pushed body -> { index, items } (or throws on a shape the deck never sends).
function sanitizeLibrary(body) {
  if (!body || typeof body !== 'object' || body.v !== 1 || !Array.isArray(body.items)) throw new Error('unsupported library');
  const seen = new Set();
  const items = [];
  for (const x of body.items.slice(0, MAX_ITEMS)) {
    if (!x || typeof x !== 'object' || typeof x.key !== 'string' || !KEY_RE.test(x.key) || seen.has(x.key)) continue;
    seen.add(x.key);
    const kind = kindOf(x.key);
    items.push({
      key: x.key, kind, title: s(x.title, 120) || x.key, description: s(x.description, 300), text: s(x.text, MAX_TEXT),
      updatedAt: time(x.updatedAt), verifiedAt: time(x.verifiedAt), tag: kind === 'note' && x.tag === 'share' ? 'share' : null,
    });
  }
  // h: a short content hash per item, so a teammate's deck can tell what changed from the index alone.
  const index = items.map(({ text, ...rest }) => ({ ...rest, size: Buffer.byteLength(text), h: sha256(JSON.stringify([rest.title, rest.description, text, rest.updatedAt, rest.verifiedAt, rest.tag])).slice(0, 16) }));
  return { index, items, trimmed: Number.isInteger(body.trimmed) && body.trimmed > 0 ? Math.min(body.trimmed, 1000) : 0 };
}

// What a grant shares as knowledge: skills with the skills scope, notes and memory with notes
// (only notes marked Share when the grant says notesTagged). item: an index entry { key, tag }.
// (An old agentLibrary flag on a stored grant is ignored.)
const skillsAllowed = (grant) => !!grant && grant.scopes.includes('skills');
const notesAllowed = (grant) => !!grant && grant.scopes.includes('notes');
const knowledgeAllowed = (grant) => skillsAllowed(grant) || notesAllowed(grant);
// What a grant with `ask` may quote in answers: skills, and notes (only marked ones if notesTagged).
const askAllowed = (item, grant) => !!grant && grant.scopes.includes('ask') && (kindOf(item.key) === 'skill' || !grant.notesTagged || item.tag === 'share');
const itemAllowed = (item, grant) => (kindOf(item.key) === 'skill' ? skillsAllowed(grant) : notesAllowed(grant) && (!grant.notesTagged || item.tag === 'share'));

// One hash over what this grant may read; it changes when an item, or the grant's reach, does.
function knowledgeHash(index, grant) {
  const items = (index || []).filter((i) => i && itemAllowed(i, grant)).map((i) => [i.key, i.h || i.size]);
  return sha256(JSON.stringify([skillsAllowed(grant), notesAllowed(grant), !!grant.notesTagged, items])).slice(0, 32);
}

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
  kindOf, sanitizeLibrary, skillsAllowed, notesAllowed, knowledgeAllowed, itemAllowed, askAllowed, knowledgeHash, newKey, parseKey, cleanLabel, keyExpiry, rateWindow, fieldOf,
};
