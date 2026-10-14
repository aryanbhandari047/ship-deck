'use strict';
// Invite-only email + password provider. A captain creates a one-time invite (24 h, single use)
// for a teammate's @keychain.com email; the teammate opens the link and sets their own password.
// Re-inviting someone is the password reset. Passwords: scrypt with a per-user random salt,
// constant-time compare, never logged, stored or returned in clear.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { normalizeEmail, emailAllowed, nameFromEmail } = require('./domain');
const { randomId, sha256 } = require('./tokens');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const INVITE_TTL_SEC = 24 * 3600;
const MAX_FAILURES = 5;
const LOCK_SEC = 15 * 60;

class AuthError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64url');
  const got = await scrypt(String(password).normalize('NFC'), Buffer.from(m[4], 'base64url'), want.length, { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw new AuthError(400, `use a password of at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) throw new AuthError(400, 'that password is too long');
}

// Compared against when the email has no account, so a miss costs the same time as a hit.
let dummyHash = null;
async function dummy() { return dummyHash || (dummyHash = await hashPassword(randomId(16))); }

// config: { domain, baseUrl }. onEvent({ type, email, ip, sub }) is the audit hook (no secrets).
function createPasswordAuth({ store, config, now = Date.now, onEvent = async () => {} }) {
  const userKey = (email) => 'user:' + normalizeEmail(email);
  const failKeys = (email, ip) => ['fail:e:' + normalizeEmail(email), 'fail:ip:' + String(ip || 'unknown')];

  async function recordFailure(email, ip) {
    const [ke, ki] = failKeys(email, ip);
    const [ne, , ni] = await store.pipeline([['INCR', ke], ['EXPIRE', ke, LOCK_SEC], ['INCR', ki], ['EXPIRE', ki, LOCK_SEC]]);
    return Math.max(Number(ne) || 0, Number(ni) || 0);
  }

  // { email, password, ip } -> { sub, email, name }. 5 failures per email or per IP lock both for 15 min.
  async function login({ email, password, ip }) {
    const e = normalizeEmail(email);
    const [ke, ki] = failKeys(e, ip);
    const [fe, fi, rawUser] = await store.cmd(['MGET', ke, ki, userKey(e)]);
    if (Number(fe) >= MAX_FAILURES || Number(fi) >= MAX_FAILURES) {
      await onEvent({ type: 'locked', email: e, ip });
      throw new AuthError(429, 'Too many attempts. Try again in 15 minutes.', { retryAfter: LOCK_SEC });
    }
    let user = null;
    try { user = rawUser ? JSON.parse(rawUser) : null; } catch { user = null; }
    const allowed = emailAllowed(e, config.domain);
    const ok = typeof password === 'string' && password.length <= MAX_PASSWORD
      && (await verifyPassword(password, allowed && user ? user.pw : await dummy())) && allowed && !!user;
    if (!ok) {
      const n = await recordFailure(e, ip);
      await onEvent({ type: n >= MAX_FAILURES ? 'locked' : 'login-failed', email: e, ip, sub: user && user.uid });
      throw new AuthError(401, 'Wrong email or password.');
    }
    await store.cmd(['DEL', ke]);
    await onEvent({ type: 'login', email: e, ip, sub: user.uid });
    return { sub: user.uid, email: e, name: user.name || nameFromEmail(e) };
  }

  // A fresh invite replaces any earlier one for the same email. Returns { link, expiresAt }.
  async function createInvite({ email, by }) {
    const e = normalizeEmail(email);
    if (!emailAllowed(e, config.domain)) throw new AuthError(400, `Invites are for @${config.domain} emails only.`);
    const token = randomId(32);
    const h = sha256(token);
    const expiresAt = now() + INVITE_TTL_SEC * 1000;
    const old = await store.cmd(['GET', 'invfor:' + e]);
    await store.pipeline([
      ...(old ? [['DEL', 'inv:' + old]] : []),
      ['SET', 'inv:' + h, JSON.stringify({ email: e, by: by || null, exp: expiresAt }), 'EX', INVITE_TTL_SEC],
      ['SET', 'invfor:' + e, h, 'EX', INVITE_TTL_SEC],
    ]);
    await onEvent({ type: 'invited', email: e, sub: by || null });
    // The token travels in the fragment, so it never reaches server logs or Referer headers.
    return { link: `${config.baseUrl}/invite#${token}`, expiresAt, email: e };
  }

  // Sets the password for the invited email (creating the account, or resetting it and signing
  // out its other sessions). The invite is consumed only by a valid password.
  async function acceptInvite({ token, password, destroyAllSessions }) {
    checkNewPassword(password);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new AuthError(400, 'This invite link is not valid.');
    const raw = await store.cmd(['GETDEL', 'inv:' + sha256(token)]);
    let inv = null;
    try { inv = raw ? JSON.parse(raw) : null; } catch { inv = null; }
    if (!inv || !(inv.exp > now())) throw new AuthError(410, 'This invite link has expired or was already used. Ask for a new one.');
    const e = normalizeEmail(inv.email);
    if (!emailAllowed(e, config.domain)) throw new AuthError(400, 'This invite link is not valid.');
    const prev = await store.cmd(['GET', userKey(e)]);
    let user = null;
    try { user = prev ? JSON.parse(prev) : null; } catch { user = null; }
    const rec = {
      uid: (user && user.uid) || randomId(12), email: e, name: (user && user.name) || nameFromEmail(e),
      pw: await hashPassword(password), createdAt: (user && user.createdAt) || now(), updatedAt: now(),
    };
    await store.pipeline([['SET', userKey(e), JSON.stringify(rec)], ['DEL', 'invfor:' + e], ['DEL', 'fail:e:' + e]]);
    if (user && destroyAllSessions) await destroyAllSessions(rec.uid);
    await onEvent({ type: user ? 'password-reset' : 'account-created', email: e, sub: rec.uid });
    return { sub: rec.uid, email: e, name: rec.name };
  }

  return { id: 'password', login, createInvite, acceptInvite };
}

module.exports = {
  AuthError, createPasswordAuth, hashPassword, verifyPassword, checkNewPassword,
  MIN_PASSWORD, MAX_FAILURES, LOCK_SEC, INVITE_TTL_SEC,
};
