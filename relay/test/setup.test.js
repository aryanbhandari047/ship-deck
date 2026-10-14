'use strict';
// The one-time owner setup link: GET /api/auth/setup?code=<SETUP_CODE> redirects the first
// captain (OWNER_EMAIL) to a fresh invite, once, and only while the relay has no accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startRelay } = require('./helpers');

const CODE = 'S'.repeat(16) + crypto.randomBytes(24).toString('base64url');
const ENV = { SETUP_CODE: CODE, OWNER_EMAIL: 'Ada@Keychain.com' };
const setup = (r, code = CODE) => r.browser().call('GET', '/api/auth/setup?code=' + encodeURIComponent(code));
const authRows = (r) => [...(r.store.peek('aud:auth') || new Map()).keys()].map((s) => JSON.parse(s));

test('setup: disabled (plain 404) without SETUP_CODE, with a short one, or without OWNER_EMAIL', async (t) => {
  for (const env of [{}, { OWNER_EMAIL: 'ada@keychain.com' }, { SETUP_CODE: CODE }, { SETUP_CODE: 'x'.repeat(31), OWNER_EMAIL: 'ada@keychain.com' }, { SETUP_CODE: CODE, OWNER_EMAIL: 'ada@gmail.com' }]) {
    const r = await startRelay(t, { env });
    const res = await setup(r, env.SETUP_CODE || CODE);
    assert.equal(res.status, 404, JSON.stringify(env));
    assert.deepEqual(res.data, { error: 'not found' });
    assert.equal(r.store.peek('setup:used'), null);
    assert.equal(r.store.peek('invfor:ada@keychain.com'), null);
  }
});

test('setup: disabled once any account exists', async (t) => {
  const r = await startRelay(t, { env: ENV });
  await r.person('grace@keychain.com');
  const res = await setup(r);
  assert.equal(res.status, 404);
  assert.deepEqual(res.data, { error: 'not found' });
  assert.equal(r.store.peek('invfor:ada@keychain.com'), null);
});

test('setup: a wrong code is a 404, audited, and locks the IP after 5 tries', async (t) => {
  const r = await startRelay(t, { env: ENV });
  for (let i = 0; i < 5; i++) {
    const res = await setup(r, CODE.slice(0, -1) + (i));
    assert.equal(res.status, 404);
    assert.deepEqual(res.data, { error: 'not found' });
  }
  const rows = authRows(r);
  assert.equal(rows.filter((x) => x.result === 'refused').length, 5);
  assert.ok(rows.every((x) => x.ip && !JSON.stringify(x).includes(CODE.slice(0, 20))), 'audited per IP, code never stored');
  assert.equal((await setup(r)).status, 404, 'locked even with the right code');
  assert.equal(r.store.peek('setup:used'), null);
  assert.equal((await r.browser().call('POST', '/api/auth/login', { email: 'ada@keychain.com', password: 'whatever password' })).status, 429, 'shares the login lockout');
  r.clock.t += 15 * 60e3 + 1;
  assert.equal((await setup(r)).status, 302, 'lock lifts after 15 minutes');
});

test('setup: the right code redirects once to an invite for OWNER_EMAIL only', async (t) => {
  const r = await startRelay(t, { env: ENV });
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.join(' '));
  t.after(() => Object.assign(console, orig));

  const res = await setup(r);
  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.match(loc, new RegExp('^' + r.base + '/invite#[A-Za-z0-9_-]{43}$'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const token = loc.split('#')[1];
  assert.ok(r.store.peek('setup:used'));
  assert.ok(r.store.peek('invfor:ada@keychain.com'));
  assert.ok(authRows(r).some((x) => x.what === 'Owner setup link opened' && x.result === 'ok'), 'audited');

  // Used up before the password is even set, then the invite works as any invite does.
  assert.equal((await setup(r)).status, 404, 'second click');
  const b = r.browser();
  const acc = await b.call('POST', '/api/auth/accept', { token, password: 'a long enough password' });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.viewer.email, 'ada@keychain.com');
  assert.equal((await setup(r)).status, 404);

  const logs = out.concat(r.logs).join('\n') + JSON.stringify(authRows(r));
  assert.ok(!logs.includes(CODE) && !logs.includes(token), 'no code or token in logs or audit');
});

test('setup: the code is compared in constant time', async (t) => {
  const r = await startRelay(t, { env: ENV });
  const spy = t.mock.method(crypto, 'timingSafeEqual');
  assert.equal((await setup(r, 'short')).status, 404);
  assert.equal(spy.mock.callCount(), 1, 'used even for a code of a different length');
  assert.equal((await setup(r)).status, 302);
  assert.equal(spy.mock.callCount(), 2);
});
