'use strict';
// Local end to end: a real Ship Deck server (--share) on a fixture home and the relay dev server on
// a memory store. The captain signs in from Settings, grants Grace, the deck pushes; Grace sees the
// board, Sam is refused, and the captain's audit shows both. The fleet home is never written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, listen } = require('../server');
const { startRelay } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');

function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

async function startDeck(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIX, path.join(dir, 'home'), { recursive: true });
  const execs = [];
  const server = createServer({
    home: path.join(dir, 'home'), ordersDir: path.join(dir, 'orders'), claudeDir: path.join(dir, 'claude'), memoryDir: null,
    tmux: false, wake: false, captainName: 'Ada',
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return { code: 0, stdout: 'pane text', stderr: '' }; },
    ...extra,
  });
  const port = await listen(server, 0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = { 'X-Ship-Deck': '1' }) => {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { server, base, call, dir, home: path.join(dir, 'home'), execs };
}

test('deck pushes; a granted teammate sees the board; an ungranted one is refused and audited', async (t) => {
  const relay = await startRelay(t);
  const ada = await relay.person('ada@keychain.com'); // bootstrap: the owner's invite
  const deck = await startDeck(t, { share: true, shareRelay: relay.base });
  const before = fingerprint(deck.home);

  let r = await deck.call('GET', '/api/share');
  assert.equal(r.data.state, 'signed-out');
  assert.ok(r.data.fleetProjects.includes('harbor-app'));

  r = await deck.call('POST', '/api/share/signin', { email: 'ada@keychain.com', password: 'wrong password' });
  assert.equal(r.status, 401);
  r = await deck.call('POST', '/api/share/signin', { email: 'ada@keychain.com', password: ada.password });
  assert.equal(r.status, 200);
  assert.equal(r.data.status.account.email, 'ada@keychain.com');
  assert.ok(!fs.readFileSync(path.join(deck.dir, 'orders', 'share.json'), 'utf8').includes(ada.password));

  assert.equal(await deck.server.shareAgent.tick(), 'idle', 'nothing is pushed before someone is added');
  assert.equal(relay.store.peek('snap:' + r.data.status.account.sub), null);

  r = await deck.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'updates', 'model'], projects: ['harbor-app'], days: 30 });
  assert.equal(r.status, 200);
  assert.equal(r.data.grants[0].hasAccount, false);
  r = await deck.call('POST', '/api/share/invite', { email: 'grace@keychain.com' });
  assert.ok(r.data.invite.link.startsWith(relay.base + '/invite#'));
  const graceToken = r.data.invite.link.split('#')[1];

  assert.equal(await deck.server.shareAgent.tick(), 'pushed');

  const grace = relay.browser();
  assert.equal((await grace.call('POST', '/api/auth/accept', { token: graceToken, password: 'grace has a long password' })).status, 200);
  r = await grace.call('GET', '/v1/decks');
  assert.equal(r.data.decks.length, 1);
  const capSub = r.data.decks[0].captainSub;
  r = await grace.call('GET', `/v1/decks/${capSub}/board`);
  assert.equal(r.status, 200);
  const ids = r.data.workers.map((w) => w.id).sort();
  assert.deepEqual(ids, ['alpha-fix', 'beta-scout', 'epsilon-resume', 'zeta-new']);
  assert.equal(r.data.hiddenProjects, 1, 'lighthouse-api stays private');
  assert.equal(r.data.workers.find((w) => w.id === 'alpha-fix').pr.number, 42);
  const text = JSON.stringify(r.data);
  for (const bad of ['/tmp/sample', 'fm-alpha-fix', 'worktree', 'pr_head', '0123456789abcdef0123', deck.home, os.homedir()]) assert.ok(!text.includes(bad), bad);
  r = await grace.call('GET', `/v1/decks/${capSub}/updates`);
  assert.ok(Object.keys(r.data.updates).length === 4);

  const sam = await relay.person('sam@keychain.com');
  r = await sam.call('GET', `/v1/decks/${capSub}/board`);
  assert.deepEqual([r.status, r.data.error], [403, 'no access']);
  r = await grace.call('GET', `/v1/decks/${capSub}/terminal`);
  assert.deepEqual([r.status, r.data.error], [403, 'not shared']);

  r = await deck.call('GET', '/api/share/audit');
  const rows = r.data.rows;
  assert.ok(rows.some((x) => x.who === 'sam@keychain.com' && x.result === 'refused' && x.reason === 'no access'));
  assert.ok(rows.some((x) => x.who === 'grace@keychain.com' && x.result === 'viewed' && x.what === 'Board'));
  assert.ok(rows.some((x) => x.who === 'grace@keychain.com' && x.result === 'refused' && x.reason === 'not shared'));
  r = await deck.call('GET', '/api/share/grants');
  assert.equal(r.data.grants[0].hasAccount, true);
  assert.ok(r.data.grants[0].lastViewed);

  // Revoke from Settings: Grace is refused at once.
  r = await deck.call('POST', '/api/share/revoke', { viewer: 'grace@keychain.com' });
  assert.equal(r.status, 200);
  r = await grace.call('GET', `/v1/decks/${capSub}/board`);
  assert.equal(r.status, 403);

  assert.deepEqual(fingerprint(deck.home), before, 'the fleet home was not written');
  assert.ok(deck.execs.every((c) => c[0] === 'tmux'), 'no fm-send, no other command');
});

test('terminal sharing uses only capture-pane and sends 40 redacted lines', async (t) => {
  const relay = await startRelay(t);
  const ada = await relay.person('ada@keychain.com');
  const deck = await startDeck(t, { share: true, shareRelay: relay.base });
  await deck.call('POST', '/api/share/signin', { email: ada.email, password: ada.password });
  await deck.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'terminal'], projects: ['harbor-app'] });
  const grace = await relay.person('grace@keychain.com');
  assert.equal(await deck.server.shareAgent.tick(), 'pushed');
  const capSub = (await grace.call('GET', '/v1/decks')).data.decks[0].captainSub;
  const r = await grace.call('GET', `/v1/decks/${capSub}/terminal`);
  assert.equal(r.status, 200);
  assert.ok(Object.values(r.data.terminal).every((x) => x.lines.length <= 40));
  assert.ok(deck.execs.length > 0 && deck.execs.every((c) => c[0] === 'tmux' && c[1] === 'capture-pane'));
});

test('sharing off: no relay traffic, share routes refuse, POST guards stay', async (t) => {
  const deck = await startDeck(t);
  assert.deepEqual((await deck.call('GET', '/api/share')).data, { enabled: false });
  assert.equal(deck.server.shareAgent, null);
  assert.equal((await deck.call('POST', '/api/share/grant', { email: 'g@keychain.com' })).status, 404);
  const relay = await startRelay(t);
  const on = await startDeck(t, { share: true, shareRelay: relay.base });
  assert.equal((await on.call('POST', '/api/share/signin', { email: 'a@keychain.com', password: 'x' }, {})).status, 403, 'X-Ship-Deck required');
  assert.equal((await on.call('POST', '/api/share/signin', { email: 'a@keychain.com', password: 'x' }, { 'X-Ship-Deck': '1', Origin: 'https://evil.example' })).status, 403);
});
