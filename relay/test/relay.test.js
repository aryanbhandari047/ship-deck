'use strict';
// Relay routes: grant checks (expired, revoked, wrong scope, wrong project, non-keychain, a
// recycled email), the append-only audit log, viewers having no write route, deck tokens, the
// Redis command budget per request, and quota errors turning into back-off answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRelay, snapshot } = require('./helpers');
const { checkAccess, validateGrant } = require('../lib/access');
const { createRelay } = require('../lib/app');
const { loadConfig } = require('../lib/config');
const { StoreError, createMemoryStore } = require('../lib/store');

const NOW = 1e12;
const DAY = 86400e3;
const grace = { sub: 'grace-sub', email: 'grace@keychain.com' };
const capWith = (g) => ({ sub: 'ada', grants: g ? { 'grace@keychain.com': { viewerEmail: 'grace@keychain.com', viewerSub: null, scopes: ['board', 'updates'], projects: ['harbor-app'], expiresAt: NOW + DAY, ...g } } : {} });

test('grant checks: no grant, revoked, expired, wrong scope, wrong project, non-keychain, recycled email', () => {
  const ok = (o) => checkAccess({ domain: 'keychain.com', now: NOW, scope: 'board', viewer: grace, ...o });
  assert.equal(ok({ cap: capWith({}) }).ok, true);
  assert.equal(ok({ cap: capWith({}), project: 'Harbor-App' }).ok, true, 'project names match in any case');
  assert.deepEqual(ok({ cap: null }), { ok: false, reason: 'no access' });
  assert.deepEqual(ok({ cap: capWith(null) }), { ok: false, reason: 'no access' }, 'revoked = deleted');
  assert.deepEqual(ok({ cap: capWith({ expiresAt: NOW }) }), { ok: false, reason: 'expired' });
  assert.deepEqual(ok({ cap: capWith({}), scope: 'terminal' }), { ok: false, reason: 'not shared' });
  assert.deepEqual(ok({ cap: capWith({}), scope: 'attachments' }), { ok: false, reason: 'not shared' });
  assert.deepEqual(ok({ cap: capWith({}), project: 'lighthouse-api' }), { ok: false, reason: 'project not shared' });
  assert.equal(ok({ cap: capWith({ projects: ['*'] }), project: 'anything' }).ok, true);
  assert.deepEqual(ok({ cap: capWith({}), viewer: { sub: 'x', email: 'grace@gmail.com' } }), { ok: false, reason: 'no access' });
  assert.deepEqual(ok({ cap: capWith({}), viewer: { sub: 'x', email: 'grace@keychain.com.evil.io' } }), { ok: false, reason: 'no access' });
  assert.deepEqual(ok({ cap: capWith({ viewerSub: 'old-grace' }) }), { ok: false, reason: 'no access' }, 'bound to the first person who used it');
  assert.equal(ok({ cap: capWith({ viewerSub: 'grace-sub' }) }).ok, true);
});

test('grant input: keychain only, never-shared scopes refused, 30-day cap, not yourself', () => {
  const v = (email, body) => validateGrant(email, body, { domain: 'keychain.com', captainEmail: 'ada@keychain.com', now: NOW });
  assert.throws(() => v('g@gmail.com', { scopes: ['board'], projects: ['*'] }), /keychain\.com/);
  assert.throws(() => v('ada@keychain.com', { scopes: ['board'], projects: ['*'] }), /own email/);
  for (const never of ['attachments', 'paths', 'sessions', 'sending']) assert.throws(() => v('g@keychain.com', { scopes: ['board', never], projects: ['*'] }), /never shared/);
  assert.throws(() => v('g@keychain.com', { scopes: ['bogus'], projects: ['*'] }), /at least one thing/);
  assert.throws(() => v('g@keychain.com', { scopes: ['board'], projects: [] }), /at least one project/);
  assert.throws(() => v('g@keychain.com', { scopes: ['board'], projects: ['*'], expiresAt: NOW - 1 }), /past/);
  const g = v('G@keychain.com', { scopes: ['updates', 'board'], projects: ['a', '*'], expiresAt: NOW + 365 * DAY });
  assert.equal(g.expiresAt, NOW + 30 * DAY);
  assert.deepEqual(g.scopes, ['board', 'updates']);
  assert.deepEqual(g.projects, ['*']);
  assert.equal(g.viewerEmail, 'g@keychain.com');
});

test('end to end on the relay: push, granted viewer reads, ungranted refused, revoke at once, all audited', async (t) => {
  const r = await startRelay(t);
  const ada = await r.captain('ada@keychain.com');
  const g = await r.person('grace@keychain.com');
  const sam = await r.person('sam@keychain.com');

  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/snapshot', snapshot())).status, 200);
  let res = await r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board', 'updates'], projects: ['harbor-app'] });
  assert.equal(res.status, 200);
  assert.equal(res.data.grants[0].hasAccount, true);

  res = await g.call('GET', '/v1/decks');
  assert.equal(res.data.decks.length, 1);
  assert.equal(res.data.decks[0].name, 'Ada');
  assert.equal(res.data.decks[0].workers, 1);
  res = await g.call('GET', `/v1/decks/${ada.sub}/board`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.workers.map((w) => w.id), ['alpha-fix'], 'only the shared project');
  assert.equal(res.data.workers[0].model, undefined, 'no model without the model scope');
  assert.equal(res.data.hiddenProjects, 1);
  res = await g.call('GET', `/v1/decks/${ada.sub}/updates?ref=refAAAAAAAAA`);
  assert.deepEqual(Object.keys(res.data.updates), ['refAAAAAAAAA']);
  res = await g.call('GET', `/v1/decks/${ada.sub}/updates?ref=refBBBBBBBBB`);
  assert.deepEqual([res.status, res.data.error], [403, 'project not shared']);
  res = await g.call('GET', `/v1/decks/${ada.sub}/terminal?ref=refAAAAAAAAA`);
  assert.deepEqual([res.status, res.data.error], [403, 'not shared']);
  res = await sam.call('GET', `/v1/decks/${ada.sub}/board`);
  assert.deepEqual([res.status, res.data.error], [403, 'no access']);
  assert.equal((await sam.call('GET', '/v1/decks')).data.decks.length, 0);
  assert.equal((await r.browser().call('GET', `/v1/decks/${ada.sub}/board`)).status, 401, 'signed out');

  // Revoke takes effect on the next request.
  assert.equal((await r.deckCall(ada.token, 'DELETE', '/v1/grants/grace%40keychain.com')).status, 200);
  res = await g.call('GET', `/v1/decks/${ada.sub}/board`);
  assert.deepEqual([res.status, res.data.error], [403, 'no access']);

  // Expiry: re-grant for one day, move the clock.
  await r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board'], projects: ['*'], expiresAt: r.clock.t + DAY });
  r.clock.t += 16 * 60e3; // past the audit de-dupe window
  assert.equal((await g.call('GET', `/v1/decks/${ada.sub}/board`)).status, 200);
  r.clock.t += DAY;
  res = await g.call('GET', `/v1/decks/${ada.sub}/board`);
  assert.deepEqual([res.status, res.data.error], [403, 'expired']);

  const rows = (await r.deckCall(ada.token, 'GET', '/v1/audit')).data.rows;
  const has = (who, result, reason, what) => rows.some((x) => x.who === who && x.result === result && (reason === undefined || x.reason === reason) && (what === undefined || x.what === what));
  assert.ok(has('grace@keychain.com', 'viewed', null, 'Board'));
  assert.ok(has('grace@keychain.com', 'refused', 'project not shared', 'Private thing, Updates'));
  assert.ok(has('grace@keychain.com', 'refused', 'not shared', 'Fix the crash, Terminal'));
  assert.ok(has('grace@keychain.com', 'refused', 'expired'));
  assert.ok(has('sam@keychain.com', 'refused', 'no access'));
  assert.ok(has('ada@keychain.com', 'granted'));
  assert.ok(has('ada@keychain.com', 'revoked'));
  assert.ok(rows.every((x, i) => i === 0 || rows[i - 1].ts >= x.ts), 'newest first');
});

test('audit is append-only: earlier rows never change, repeat views collapse for 15 minutes, rows age out after 90 days', async (t) => {
  const r = await startRelay(t);
  const ada = await r.captain();
  const g = await r.person('grace@keychain.com');
  await r.deckCall(ada.token, 'POST', '/v1/snapshot', snapshot());
  await r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board'], projects: ['*'] });
  const raw = () => [...r.store.peek('aud:' + ada.sub).keys()];
  const before = raw();
  for (let i = 0; i < 5; i++) await g.call('GET', `/v1/decks/${ada.sub}/board`);
  const after = raw();
  assert.deepEqual(after.slice(0, before.length), before, 'existing rows untouched');
  assert.equal(after.length, before.length + 1, 'five quick views, one row');
  r.clock.t += 15 * 60e3 + 1;
  await g.call('GET', `/v1/decks/${ada.sub}/board`);
  assert.equal(raw().length, before.length + 2);
  // The routes can only add rows: nothing edits or deletes a row except the 90-day age-out.
  const src = require('node:fs').readFileSync(require.resolve('../lib/app'), 'utf8');
  assert.deepEqual([...new Set([...src.matchAll(/\['(Z[A-Z]+)', ?'aud:|\['(Z[A-Z]+)', key/g)].map((m) => m[1] || m[2]))].sort(), ['ZADD', 'ZREMRANGEBYSCORE', 'ZREVRANGEBYSCORE']);
  r.clock.t += 91 * DAY;
  await r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board'], projects: ['*'] }); // keeps the record alive
  const rows = (await r.deckCall(ada.token, 'GET', '/v1/audit')).data.rows;
  assert.equal(rows.length, 1, 'only the fresh grant row is within 90 days');
});

test('viewers have no write route; deck routes refuse cookies; nothing else is routed', async (t) => {
  const r = await startRelay(t);
  const ada = await r.captain();
  const g = await r.person('grace@keychain.com');
  await r.deckCall(ada.token, 'POST', '/v1/snapshot', snapshot());
  await r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board'], projects: ['*'] });
  for (const p of ['/v1/decks', `/v1/decks/${ada.sub}/board`, `/v1/decks/${ada.sub}/updates`]) {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await g.call(m, p, {});
      assert.equal(res.status, 405, `${m} ${p}`);
      assert.equal(res.headers.get('allow'), 'GET');
    }
  }
  // A signed-in viewer's cookie is not a deck credential.
  for (const [m, p, body] of [['POST', '/v1/snapshot', snapshot()], ['PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board'], projects: ['*'] }], ['DELETE', '/v1/grants/grace%40keychain.com'], ['GET', '/v1/grants'], ['GET', '/v1/audit'], ['POST', '/v1/invites', { email: 'x@keychain.com' }], ['DELETE', '/v1/device']]) {
    assert.equal((await g.call(m, p, body)).status, 401, `${m} ${p}`);
  }
  // Grace's own deck token only ever touches Grace's own record.
  const gt = (await r.deckCall(null, 'POST', '/v1/device/login', { email: g.email, password: g.password })).data.token;
  await r.deckCall(gt, 'DELETE', '/v1/grants/grace%40keychain.com');
  assert.equal((await g.call('GET', `/v1/decks/${ada.sub}/board`)).status, 200, "Ada's grant is untouched");
  assert.equal((await r.deckCall(ada.token, 'DELETE', '/v1/grants/%E0%A4%A')).status, 400, 'malformed escape');
  for (const p of ['/v1/orders', '/v1/send', '/api/send', '/v1/decks/x/board/send', '/v1/attachments/1']) assert.equal((await g.call('POST', p, {})).status, 404, p);
});

test('deck tokens: forged, tampered or signed-out tokens are refused', async (t) => {
  const r = await startRelay(t);
  const ada = await r.captain();
  const [, body] = ada.token.split('.');
  const other = Buffer.from(JSON.stringify({ sub: 'someone-else', dev: 'x', iat: 1 })).toString('base64url');
  for (const bad of ['nope', ada.token.replace(body, other), ada.token.slice(0, -2) + 'AA', 'sdt1.' + other + '.' + 'A'.repeat(43)]) {
    assert.equal((await r.deckCall(bad, 'GET', '/v1/grants')).status, 401);
  }
  assert.equal((await r.deckCall(ada.token, 'DELETE', '/v1/device')).status, 200);
  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/snapshot', snapshot())).status, 401, 'signed out device');
});

test('free-tier budget: a push is 2 Redis commands, a repeat view is 1', async (t) => {
  const r = await startRelay(t);
  const ada = await r.captain();
  const g = await r.person('grace@keychain.com');
  await r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board'], projects: ['*'] });
  const count = async (fn) => { const n = r.store.stats.commands; await fn(); return r.store.stats.commands - n; };
  assert.equal(await count(() => r.deckCall(ada.token, 'POST', '/v1/snapshot', snapshot())), 2);
  await g.call('GET', `/v1/decks/${ada.sub}/board`); // first view: binds the grant, writes an audit row
  assert.equal(await count(() => g.call('GET', `/v1/decks/${ada.sub}/board`)), 1);
  assert.equal(await count(() => r.deckCall(ada.token, 'GET', '/v1/grants?brief=1')), 1);
});

test('store quota errors answer 503 with Retry-After instead of failing loudly', async () => {
  const store = createMemoryStore();
  const config = loadConfig({ SESSION_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: 'http://127.0.0.1:1' });
  const handle = createRelay({ config, store: { cmd: async () => { throw new StoreError('ERR max requests limit exceeded. Limit: 500000', { quota: true }); }, pipeline: store.pipeline }, log: () => {} });
  const res = { headers: null, status: 0, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
  const req = { method: 'GET', url: '/v1/grants', headers: { authorization: 'Bearer sdt1.' + 'a'.repeat(20) + '.' + 'b'.repeat(43) }, resume() {} };
  // A bad token fails before the store; use a viewer route that reads the store first.
  req.url = '/v1/decks/abcdefgh12/board';
  req.headers = { cookie: 'sd_session=' + 'x'.repeat(43) };
  await handle(req, res);
  assert.equal(res.status, 503);
  assert.equal(res.headers['Retry-After'], '900');
  assert.deepEqual(JSON.parse(res.body), { error: 'quota' });
});

test('config: refuses to run on Vercel without https, a long secret and Upstash', () => {
  const { configProblems } = require('../lib/config');
  assert.ok(configProblems(loadConfig({ VERCEL: '1' })).length >= 3);
  assert.deepEqual(configProblems(loadConfig({ VERCEL: '1', PUBLIC_BASE_URL: 'https://relay.example', SESSION_SECRET: 'x'.repeat(32), UPSTASH_REDIS_REST_URL: 'https://u', UPSTASH_REDIS_REST_TOKEN: 't' })), []);
  assert.deepEqual(configProblems(loadConfig({ VERCEL: '1', PUBLIC_BASE_URL: 'https://relay.example', SESSION_SECRET: 'x'.repeat(32), KV_REST_API_URL: 'https://u', KV_REST_API_TOKEN: 't' })), [], 'marketplace variable names work too');
});
