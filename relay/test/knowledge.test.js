'use strict';
// Knowledge sync: a teammate's own deck (its deck token, no extra key) lists every deck shared with
// its account whose grant has skills or notes, with a hash, and reads one deck's granted items.
// Skills need skills, notes need notes; revoked or expired grants drop out; GET only; cheap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRelay } = require('./helpers');

const LIB = {
  v: 1,
  items: [
    { key: 'skill:captain:deploy', title: 'deploy', description: 'How we ship', text: '---\nname: deploy\ndescription: How we ship\n---\n# Deploy\n\nRun the release script.' },
    { key: 'memory:fleet-habits.md', title: 'Fleet habits', description: '', text: 'Captain likes small PRs.' },
  ],
};

async function setup(t, scopes = ['board', 'skills']) {
  const r = await startRelay(t);
  const ada = await r.captain('ada@keychain.com');
  const grace = await r.captain('grace@keychain.com'); // her own Ship Deck, signed in
  const grant = (sc, extra = {}) => r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: sc, projects: ['*'], ...extra });
  assert.equal((await grant(scopes)).status, 200);
  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/library', LIB)).status, 200);
  const list = async () => (await r.deckCall(grace.token, 'GET', '/v1/knowledge')).data.decks;
  const read = (sub = ada.sub) => r.deckCall(grace.token, 'GET', '/v1/knowledge/' + sub);
  return { r, ada, grace, grant, list, read };
}

test('a teammate deck lists shared knowledge with a hash and reads only the granted items', async (t) => {
  const { r, ada, grant, list, read } = await setup(t);
  const [d] = await list();
  assert.equal(d.captainSub, ada.sub);
  assert.equal(d.skills, true);
  assert.equal(d.notes, false);
  assert.equal(d.offline, false);
  assert.match(d.hash, /^[\w-]{32}$/);
  const full = await read();
  assert.equal(full.status, 200);
  assert.equal(full.data.hash, d.hash);
  assert.deepEqual(full.data.items.map((i) => i.key), ['skill:captain:deploy'], 'skills only');
  assert.match(full.data.items[0].text, /Run the release script/);
  // Notes too: the hash changes; notes alone: no skills.
  await grant(['board', 'skills', 'notes']);
  const [d2] = await list();
  assert.notEqual(d2.hash, d.hash);
  assert.deepEqual((await read()).data.items.map((i) => i.key), ['skill:captain:deploy', 'memory:fleet-habits.md']);
  await grant(['board', 'notes']);
  assert.deepEqual((await read()).data.items.map((i) => i.key), ['memory:fleet-habits.md']);
  // The same library pushed again (the hourly keep-alive) keeps the hash; an edit changes it.
  const h = (await list())[0].hash;
  r.clock.t += 3600e3;
  await r.deckCall(ada.token, 'POST', '/v1/library', LIB);
  assert.equal((await list())[0].hash, h);
  await r.deckCall(ada.token, 'POST', '/v1/library', { v: 1, items: [LIB.items[0], { ...LIB.items[1], text: 'Captain likes tiny PRs.' }] });
  assert.notEqual((await list())[0].hash, h);
});

test('no skills or notes, revoked, expired or an old agentLibrary flag: nothing listed and reads refused', async (t) => {
  const { r, ada, grant, list, read } = await setup(t, ['board']);
  assert.deepEqual(await list(), []);
  assert.equal((await read()).status, 403);
  await grant(['board', 'agentLibrary']);
  assert.deepEqual(await list(), [], 'agentLibrary alone is ignored');
  await grant(['board', 'skills']);
  assert.equal((await list()).length, 1);
  await r.deckCall(ada.token, 'DELETE', '/v1/grants/grace%40keychain.com');
  assert.deepEqual(await list(), []);
  assert.equal((await read()).status, 403, 'revoked: 403, not 401 (401 means the device was signed out)');
  await grant(['board', 'skills'], { expiresAt: r.clock.t + 86400e3 });
  r.clock.t += 2 * 86400e3;
  assert.deepEqual(await list(), []);
  assert.equal((await read()).status, 403);
  // A deck that was never shared, and one that does not exist.
  const bob = await r.captain('bob@keychain.com');
  assert.equal((await read(bob.sub)).status, 403);
  assert.equal((await read('nosuchdeck123')).status, 404);
});

test('offline captain: listed without a hash; the captain sees one audit row per sync', async (t) => {
  const { r, ada, list, read } = await setup(t);
  await read();
  const rows = (await r.deckCall(ada.token, 'GET', '/v1/audit')).data.rows;
  assert.ok(rows.some((x) => x.who === 'grace@keychain.com' && x.result === 'agent sync' && /1 skill$/.test(x.what)));
  await r.deckCall(ada.token, 'DELETE', '/v1/library');
  const [d] = await list();
  assert.equal(d.offline, true);
  assert.equal(d.hash, null);
});

test('deck token only, GET only: sessions, agent keys and other methods are refused', async (t) => {
  const { r, ada, grace } = await setup(t);
  assert.equal((await grace.call('GET', '/v1/knowledge')).status, 401, 'a browser session is not a deck token');
  assert.equal((await r.deckCall('sdak1.' + ada.sub + '.' + 'A'.repeat(43), 'GET', '/v1/knowledge')).status, 401);
  for (const m of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await r.deckCall(grace.token, m, '/v1/knowledge', m === 'DELETE' ? undefined : LIB)).status, 405);
    assert.equal((await r.deckCall(grace.token, m, '/v1/knowledge/' + ada.sub, m === 'DELETE' ? undefined : LIB)).status, 405);
  }
});

test('free-tier budget: a hash check is 4 Redis commands for one captain, a full read 5', async (t) => {
  const { r, grace, read } = await setup(t);
  const count = async (fn) => { const n = r.store.stats.commands; await fn(); return r.store.stats.commands - n; };
  assert.equal(await count(() => r.deckCall(grace.token, 'GET', '/v1/knowledge')), 4);
  await read(); // binds the grant on first use
  assert.equal(await count(() => read()), 5);
});

test('knowledge version: moves on a grant change or new content, not on a keep-alive; an unchanged check is 1 command', async (t) => {
  const { r, ada, grace, grant } = await setup(t);
  const check = (since) => r.deckCall(grace.token, 'GET', '/v1/knowledge' + (since ? '?since=' + since : ''));
  const v1 = (await check()).data.version;
  assert.match(v1, /^\d+$/);
  // Every deck answer carries it, so a deck that refreshes its grants anyway needs no extra call.
  assert.equal((await r.deckCall(grace.token, 'GET', '/v1/grants?brief=1')).data.knowledge, v1);
  const n = r.store.stats.commands;
  assert.deepEqual((await check(v1)).data, { same: true, version: v1 });
  assert.equal(r.store.stats.commands - n, 1);
  // The hourly keep-alive with the same content: unchanged.
  await r.deckCall(ada.token, 'POST', '/v1/library', LIB);
  assert.equal((await check(v1)).data.same, true);
  // New content: moved, and the full list comes back.
  await r.deckCall(ada.token, 'POST', '/v1/library', { v: 1, items: [LIB.items[0]] });
  const after = (await check(v1)).data;
  assert.ok(!after.same && after.version !== v1 && after.decks.length === 1);
  // A grant change moves it too, and so does a revoke.
  await grant(['board', 'skills', 'notes']);
  assert.notEqual((await check(after.version)).data.version, after.version);
  const v3 = (await check()).data.version;
  await r.deckCall(ada.token, 'DELETE', '/v1/grants/grace%40keychain.com');
  assert.notEqual((await check(v3)).data.version, v3);
});
