'use strict';
// Invite-only email + password auth: the domain rule, invites (24 h, single use, reset), scrypt,
// lockout per email and per IP, sessions (7 days, logout), and that no password ever shows up in
// responses, logs or the store.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRelay } = require('./helpers');
const { emailAllowed } = require('../auth/domain');
const { hashPassword, verifyPassword } = require('../auth/password');
const { sessionKey } = require('../auth/sessions');

test('only exact @keychain.com emails, any case', () => {
  for (const ok of ['ada@keychain.com', 'Ada.Example@KEYCHAIN.COM', ' grace+deck@keychain.com ']) assert.ok(emailAllowed(ok, 'keychain.com'), ok);
  for (const bad of ['ada@gmail.com', 'ada@keychain.co', 'ada@mail.keychain.com', 'ada@keychain.com.evil.io', 'ada@evilkeychain.com', 'keychain.com', '@keychain.com', 'a@b@keychain.com', 'a..b@keychain.com', 'ada@kéychain.com']) {
    assert.ok(!emailAllowed(bad, 'keychain.com'), bad);
  }
});

test('scrypt: per-user salt, verify, constant-time compare, no plaintext', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b, 'random salt');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!a.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse batterz', a), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('invites: keychain only, 24 h expiry, single use, a new one replaces the old, re-invite resets the password', async (t) => {
  const r = await startRelay(t);
  await assert.rejects(r.auth.createInvite({ email: 'ada@gmail.com' }), /keychain\.com/);
  const b = r.browser();

  const inv = await r.auth.createInvite({ email: 'Ada@Keychain.com' });
  assert.match(inv.link, new RegExp('^' + r.base + '/invite#[A-Za-z0-9_-]{43}$'));
  const token = inv.link.split('#')[1];
  let res = await b.call('POST', '/api/auth/accept', { token, password: 'short' });
  assert.equal(res.status, 400, 'min length 12');
  res = await b.call('POST', '/api/auth/accept', { token, password: 'a long enough password' });
  assert.equal(res.status, 200, 'a bad password did not burn the invite');
  assert.deepEqual(res.data.viewer, { email: 'ada@keychain.com', name: 'Ada' });
  res = await r.browser().call('POST', '/api/auth/accept', { token, password: 'another long password' });
  assert.equal(res.status, 410, 'single use');

  const old = (await r.auth.createInvite({ email: 'grace@keychain.com' })).link.split('#')[1];
  const fresh = (await r.auth.createInvite({ email: 'grace@keychain.com' })).link.split('#')[1];
  assert.equal((await r.browser().call('POST', '/api/auth/accept', { token: old, password: 'a long enough password' })).status, 410, 'replaced');
  const late = (await r.auth.createInvite({ email: 'linus@keychain.com' })).link.split('#')[1];
  r.clock.t += 24 * 3600e3 + 1;
  assert.equal((await r.browser().call('POST', '/api/auth/accept', { token: fresh, password: 'a long enough password' })).status, 410, 'expired after 24 h');
  assert.equal((await r.browser().call('POST', '/api/auth/accept', { token: late, password: 'a long enough password' })).status, 410);

  // Reset: a new invite for an existing account sets a new password and ends its sessions.
  assert.equal((await b.call('GET', '/v1/decks')).status, 200);
  const reset = (await r.auth.createInvite({ email: 'ada@keychain.com' })).link.split('#')[1];
  const b2 = r.browser();
  assert.equal((await b2.call('POST', '/api/auth/accept', { token: reset, password: 'a brand new password' })).status, 200);
  assert.equal((await b.call('GET', '/v1/decks')).status, 401, 'old session ended by the reset');
  assert.equal((await r.browser().call('POST', '/api/auth/login', { email: 'ada@keychain.com', password: 'a long enough password' })).status, 401);
  assert.equal((await r.browser().call('POST', '/api/auth/login', { email: 'ada@keychain.com', password: 'a brand new password' })).status, 200);
});

test('there is no sign-up: login needs an invited account; non-keychain emails never get in', async (t) => {
  const r = await startRelay(t);
  assert.equal((await r.browser().call('POST', '/api/auth/login', { email: 'new@keychain.com', password: 'whatever password' })).status, 401);
  assert.equal((await r.browser().call('POST', '/api/auth/signup', { email: 'new@keychain.com', password: 'whatever password' })).status, 404);
  assert.equal((await r.browser().call('POST', '/api/auth/login', { email: 'x@gmail.com', password: 'whatever password' })).status, 401);
});

test('lockout: 5 failures per email or per IP lock for 15 minutes, and are audited', async (t) => {
  const r = await startRelay(t, { env: { OWNER_EMAIL: 'ada@keychain.com' } });
  const ada = await r.captain('ada@keychain.com');
  const login = (email, password) => r.browser().call('POST', '/api/auth/login', { email, password });
  for (let i = 0; i < 5; i++) assert.equal((await login('ada@keychain.com', 'wrong password ' + i)).status, 401);
  let res = await login('ada@keychain.com', ada.password);
  assert.equal(res.status, 429, 'locked even with the right password');
  assert.equal(res.headers.get('retry-after'), '900');
  r.clock.t += 15 * 60e3 + 1000;
  assert.equal((await login('ada@keychain.com', ada.password)).status, 200, 'unlocked after 15 minutes');

  // Per IP: spraying different emails from one address also locks.
  r.clock.t += 16 * 60e3;
  for (let i = 0; i < 5; i++) await login(`nobody${i}@keychain.com`, 'wrong password');
  assert.equal((await login('ada@keychain.com', ada.password)).status, 429, 'this IP is locked');
  r.clock.t += 16 * 60e3;

  const audit = await r.deckCall(ada.token, 'GET', '/v1/audit');
  const rows = audit.data.rows;
  assert.ok(rows.some((x) => x.what === 'Sign-in attempt' && x.reason === 'locked for 15 minutes' && x.who === 'ada@keychain.com'));
  assert.ok(rows.some((x) => x.who === 'nobody0@keychain.com' && x.result === 'refused'), 'the owner sees attempts on other emails');
});

test('sessions: opaque, hashed in the store, HttpOnly Secure SameSite=Lax, 7 days, logout ends them', async (t) => {
  const r = await startRelay(t);
  const p = await r.person('grace@keychain.com');
  const res = await r.browser().call('POST', '/api/auth/login', { email: p.email, password: p.password });
  const set = res.setCookie;
  assert.match(set, /^sd_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
  const id = set.split(';')[0].split('=')[1];
  assert.equal(r.store.peek('sess:' + id), null, 'the raw id is not a key');
  assert.ok(r.store.peek(sessionKey(id)), 'only its hash is stored');

  const b = r.browser();
  b.cookie = set.split(';')[0];
  assert.equal((await b.call('GET', '/v1/decks')).status, 200);
  r.clock.t += 7 * 86400e3 + 1;
  assert.equal((await b.call('GET', '/v1/decks')).status, 401, 'expired after 7 days');

  const again = await r.browser().call('POST', '/api/auth/login', { email: p.email, password: p.password });
  const b2 = r.browser();
  b2.cookie = again.setCookie.split(';')[0];
  const kept = b2.cookie;
  assert.equal((await b2.call('GET', '/v1/decks')).status, 200);
  const out = await b2.call('POST', '/api/auth/logout', {});
  assert.match(out.setCookie, /Max-Age=0/);
  b2.cookie = kept; // a copied cookie stops working too
  assert.equal((await b2.call('GET', '/v1/decks')).status, 401);
});

test('cookie POSTs refuse other origins (login CSRF)', async (t) => {
  const r = await startRelay(t);
  const p = await r.person('grace@keychain.com');
  const res = await r.browser().call('POST', '/api/auth/login', { email: p.email, password: p.password }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const form = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(form.status, 415);
});

test('no password in responses, logs or the store', async (t) => {
  const r = await startRelay(t);
  const SECRET = 'Sup3r-Secret-Passphrase-42';
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.join(' '));
  t.after(() => Object.assign(console, orig));

  const inv = await r.auth.createInvite({ email: 'ada@keychain.com' });
  const b = r.browser();
  const responses = [];
  responses.push(await b.call('POST', '/api/auth/accept', { token: inv.link.split('#')[1], password: SECRET }));
  responses.push(await r.browser().call('POST', '/api/auth/login', { email: 'ada@keychain.com', password: SECRET }));
  responses.push(await r.browser().call('POST', '/api/auth/login', { email: 'ada@keychain.com', password: SECRET + 'x' }));
  responses.push(await r.deckCall(null, 'POST', '/v1/device/login', { email: 'ada@keychain.com', password: SECRET, device: 'd' }));
  responses.push(await r.deckCall(null, 'POST', '/v1/device/login', { email: 'ada@keychain.com', password: SECRET + 'y', device: 'd' }));
  for (const res of responses) assert.ok(!res.raw.includes(SECRET) && !String(res.setCookie || '').includes(SECRET));
  assert.ok(!out.join('\n').includes(SECRET), 'console');
  assert.ok(!r.logs.join('\n').includes(SECRET), 'relay log');
  for (const k of ['user:ada@keychain.com', 'aud:auth']) {
    const v = r.store.peek(k);
    const s = v instanceof Map ? [...v.keys()].join('\n') : String(v);
    assert.ok(!s.includes(SECRET), k);
  }
});
