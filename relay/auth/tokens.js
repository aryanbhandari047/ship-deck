'use strict';
// Small crypto helpers shared by the auth providers: random ids, hashing for storage keys and
// HMAC-signed deck tokens ("sdt1.<payload>.<mac>", bound to the captain's sub and one device).
const crypto = require('node:crypto');

const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const macKey = (secret) => crypto.createHmac('sha256', String(secret)).update('ship-deck deck token v1').digest();

function signDeckToken(secret, { sub, dev }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ sub, dev, iat: now })).toString('base64url');
  const mac = crypto.createHmac('sha256', macKey(secret)).update(body).digest('base64url');
  return `sdt1.${body}.${mac}`;
}

// Returns { sub, dev, iat } or null. The device must also still exist in the captain's record.
function verifyDeckToken(secret, token) {
  const m = /^sdt1\.([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return null;
  const want = crypto.createHmac('sha256', macKey(secret)).update(m[1]).digest('base64url');
  if (!safeEqual(want, m[2])) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return typeof p.sub === 'string' && typeof p.dev === 'string' ? p : null;
  } catch { return null; }
}

module.exports = { randomId, sha256, safeEqual, signDeckToken, verifyDeckToken };
