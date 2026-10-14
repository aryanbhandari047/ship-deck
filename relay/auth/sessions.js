'use strict';
// Browser sessions: an opaque random id in an HttpOnly, Secure, SameSite=Lax cookie; the store
// keeps only its hash (sess:<sha256>) with a 7-day expiry. Shared by every auth provider.
const { randomId, sha256 } = require('./tokens');

const COOKIE = 'sd_session';
const TTL_SEC = 7 * 86400;

const sessionKey = (id) => 'sess:' + sha256(id);

function createSessions({ store, now = Date.now }) {
  // identity: { sub, email, name } from a provider. Returns the cookie value.
  async function create(identity) {
    const id = randomId(32);
    const h = sha256(id);
    const rec = { sub: identity.sub, email: identity.email, name: identity.name, exp: now() + TTL_SEC * 1000 };
    await store.pipeline([
      ['SET', 'sess:' + h, JSON.stringify(rec), 'EX', TTL_SEC],
      ['SADD', 'usess:' + identity.sub, h],
      ['EXPIRE', 'usess:' + identity.sub, TTL_SEC],
    ]);
    return id;
  }
  // A stored record (already fetched, often in the same MGET as the data) -> identity or null.
  function check(raw) {
    if (!raw) return null;
    try {
      const r = JSON.parse(raw);
      return r && r.exp > now() && r.sub && r.email ? { sub: r.sub, email: r.email, name: r.name } : null;
    } catch { return null; }
  }
  async function get(id) { return id ? check(await store.cmd(['GET', sessionKey(id)])) : null; }
  async function destroy(id, sub) {
    if (!id) return;
    const cmds = [['DEL', sessionKey(id)]];
    if (sub) cmds.push(['SREM', 'usess:' + sub, sha256(id)]);
    await store.pipeline(cmds);
  }
  // Every session of one person (after a password reset).
  async function destroyAll(sub) {
    const hs = await store.cmd(['SMEMBERS', 'usess:' + sub]);
    await store.pipeline([...(hs || []).map((h) => ['DEL', 'sess:' + h]), ['DEL', 'usess:' + sub]]);
  }
  function cookie(id, { secure = true } = {}) {
    return `${COOKIE}=${id}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${TTL_SEC}`;
  }
  function clearCookie({ secure = true } = {}) {
    return `${COOKIE}=; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=0`;
  }
  return { create, check, get, destroy, destroyAll, cookie, clearCookie };
}

function readCookie(req, name = COOKIE) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9_-]{20,100})(?:;|$)').exec(String(req.headers.cookie || ''));
  return m ? m[1] : null;
}

module.exports = { COOKIE, TTL_SEC, sessionKey, createSessions, readCookie };
