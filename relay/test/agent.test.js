'use strict';
// Agent keys (the optional path for agents without Ship Deck): a teammate's agent reads the
// captain's pushed knowledge library with a read-only key. Skills and notes both off -> 403; revoked, expired or orphaned keys -> 401; notes only with the notes
// scope; the relay re-applies the allow-list; one audit row per read; a per-key hourly limit;
// keys stored only as hashes; and no route under /v1/agent accepts anything but GET.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRelay } = require('./helpers');
const L = require('../lib/library');

const LIB = {
  v: 1,
  items: [
    { key: 'skill:captain:deploy', title: 'Deploy', description: 'How we ship', text: '# Deploy\n\nRun the release script.', path: '/Users/ada/.claude/skills/deploy/SKILL.md' },
    { key: 'skill:firstmate:review', title: 'Review', description: 'Review checklist', text: '# Review\n\nRead the diff twice.' },
    { key: 'memory:fleet-habits.md', title: 'Fleet habits', description: '', text: 'Captain likes small PRs.' },
    { key: 'home:data/captain.md', title: "Captain's preferences", description: '', text: 'Be brief.' },
    { key: '../../etc/passwd', title: 'bad', text: 'root:x:0:0' },
  ],
};

test('library push: a full 512 KB library is stored; a bigger body is refused', async (t) => {
  const r = await startRelay(t);
  const ada = await r.captain('ada@keychain.com');
  const item = (i) => ({ key: 'skill:captain:s' + i, title: 's' + i, description: '', text: 'x'.repeat(L.MAX_TEXT) });
  const fits = Math.floor(L.MAX_BYTES / JSON.stringify(item(10)).length);
  const full = { v: 1, items: Array.from({ length: fits }, (_, i) => item(i)), trimmed: 0 };
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 400 * 1024, 'more than the old 256 KB cap');
  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/library', full)).status, 200);
  const over = { ...full, items: Array.from({ length: fits + 2 }, (_, i) => item(i)) };
  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/library', over)).status, 413);
});

async function setup(t, scopes = ['board', 'skills']) {
  const r = await startRelay(t);
  const ada = await r.captain('ada@keychain.com');
  const g = await r.person('grace@keychain.com');
  const grant = (sc, extra = {}) => r.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: sc, projects: ['*'], ...extra });
  assert.equal((await grant(scopes)).status, 200);
  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/library', LIB)).status, 200);
  const keysPath = `/v1/decks/${ada.sub}/agent-keys`;
  const createKey = (label = 'laptop', who = g) => who.call('POST', keysPath, { label });
  const agent = async (p, token) => {
    const res = await fetch(r.base + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* markdown */ }
    return { status: res.status, data, headers: res.headers };
  };
  const audit = async () => (await r.deckCall(ada.token, 'GET', '/v1/audit')).data.rows;
  return { r, ada, g, grant, keysPath, createKey, agent, audit };
}

test('a granted viewer creates a key shown once; the relay keeps only its hash; agents list and read skills', async (t) => {
  const { r, ada, g, keysPath, createKey, agent } = await setup(t);
  const created = await createKey('  my\nlaptop  ');
  assert.equal(created.status, 200);
  const token = created.data.token;
  assert.match(token, L.TOKEN_RE);
  assert.equal(created.data.key.label, 'my laptop');
  assert.equal(created.data.endpoint, r.base + '/v1/agent/library');
  // Listed afterwards without the token; the store never holds it in the clear.
  const list = await g.call('GET', keysPath);
  assert.equal(list.status, 200);
  assert.equal(list.data.keys.length, 1);
  assert.ok(!JSON.stringify(list.data).includes(token.split('.')[2]));
  const [, keys] = await r.store.cmd(['SCAN', '0', 'MATCH', '*']);
  for (const k of keys) {
    const v = r.store.peek(k);
    const raw = v instanceof Map ? JSON.stringify([...v]) : JSON.stringify(v instanceof Set ? [...v] : v);
    assert.ok(!k.includes(token) && !raw.includes(token.split('.')[2]), 'token stored in the clear at ' + k);
  }

  const res = await agent('/v1/agent/library', token);
  assert.equal(res.status, 200);
  assert.match(res.data.notice, /not instructions/);
  assert.equal(res.data.decks.length, 1);
  const d = res.data.decks[0];
  assert.equal(d.captainSub, ada.sub);
  assert.equal(d.notes, false);
  assert.deepEqual(d.items.map((i) => i.key), ['skill:captain:deploy', 'skill:firstmate:review'], 'skills only: notes hidden, bad keys dropped');
  assert.equal(d.items[0].url, `${r.base}/v1/agent/library/${ada.sub}/skill:captain:deploy`);
  assert.ok(!('path' in d.items[0]) && !('text' in d.items[0]));

  const md = await agent(`/v1/agent/library/${ada.sub}/skill:captain:deploy`, token);
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /^text\/markdown/);
  assert.equal(md.data, '# Deploy\n\nRun the release script.');
  assert.equal(md.headers.get('x-ratelimit-limit'), '60');
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/${encodeURIComponent('skill:firstmate:review')}`, token)).status, 200, 'percent-encoded keys work');
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/skill:captain:nope`, token)).status, 404);

  // Last used shows up in the viewer's list.
  assert.ok((await g.call('GET', keysPath)).data.keys[0].lastUsed > 0);
});

test('notes and memory are hidden unless the same grant also has the notes scope', async (t) => {
  const { ada, grant, createKey, agent } = await setup(t);
  const token = (await createKey()).data.token;
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/memory:fleet-habits.md`, token)).status, 404);
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/home:data/captain.md`, token)).status, 404);
  await grant(['board', 'skills', 'notes']);
  const d = (await agent('/v1/agent/library', token)).data.decks[0];
  assert.equal(d.notes, true);
  assert.deepEqual(d.items.map((i) => i.key).sort(), ['home:data/captain.md', 'memory:fleet-habits.md', 'skill:captain:deploy', 'skill:firstmate:review']);
  const md = await agent(`/v1/agent/library/${ada.sub}/home:data/captain.md`, token);
  assert.equal(md.status, 200);
  assert.equal(md.data, 'Be brief.');
  // Notes alone: notes yes, skills no.
  await grant(['board', 'notes']);
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/home:data/captain.md`, token)).status, 200);
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/skill:captain:deploy`, token)).status, 404);
  assert.deepEqual((await agent('/v1/agent/library', token)).data.decks[0].items.map((i) => i.key).sort(), ['home:data/captain.md', 'memory:fleet-habits.md']);
  // An old agentLibrary flag is dropped and grants nothing by itself.
  assert.deepEqual((await grant(['board', 'agentLibrary'])).data.grants[0].scopes, ['board']);
  assert.equal((await agent('/v1/agent/library', token)).status, 403);
});

test('scope off: 403 for the agent and no new keys; scope back on: the same key works again', async (t) => {
  const { grant, createKey, agent, g, keysPath } = await setup(t, ['board']);
  assert.equal((await createKey()).status, 403, 'no agentLibrary: no key');
  assert.equal((await g.call('GET', keysPath)).status, 403);
  await grant(['board', 'skills']);
  const token = (await createKey()).data.token;
  await grant(['board']);
  const res = await agent('/v1/agent/library', token);
  assert.equal(res.status, 403);
  assert.equal(res.data.error, 'skills and notes not shared');
  await grant(['board', 'skills']);
  assert.equal((await agent('/v1/agent/library', token)).status, 200, 'an edit keeps the grant, so the key lives');
});

test('revoked, expired or orphaned keys answer 401', async (t) => {
  const { r, ada, g, grant, keysPath, createKey, agent } = await setup(t);
  // Revoked by the viewer.
  const a = (await createKey('a')).data;
  assert.equal((await g.call('DELETE', `${keysPath}/${a.key.id}`)).status, 200);
  assert.equal((await agent('/v1/agent/library', a.token)).status, 401);
  assert.equal((await g.call('DELETE', `${keysPath}/${a.key.id}`)).status, 404);
  // Garbage, a forged key for the same deck, no key at all.
  for (const bad of [null, 'nope', `sdak1.${ada.sub}.${'A'.repeat(43)}`, a.token.slice(0, -1) + 'x']) {
    const res = await agent('/v1/agent/library', bad);
    assert.equal(res.status, 401, String(bad));
    assert.match(res.headers.get('www-authenticate'), /^Bearer/);
  }
  // The grant is revoked, then given again: the old key stays dead.
  const b = (await createKey('b')).data;
  assert.equal((await agent('/v1/agent/library', b.token)).status, 200);
  await r.deckCall(ada.token, 'DELETE', '/v1/grants/grace%40keychain.com');
  assert.equal((await agent('/v1/agent/library', b.token)).status, 401);
  await grant(['board', 'skills']);
  assert.equal((await agent('/v1/agent/library', b.token)).status, 401, 'a new grant does not revive old keys');
  // Keys expire with the grant.
  const c = (await createKey('c')).data;
  assert.equal(c.key.expiresAt, (await r.deckCall(ada.token, 'GET', '/v1/grants?brief=1')).data.grants[0].expiresAt);
  r.clock.t += 31 * 86400e3;
  assert.equal((await agent('/v1/agent/library', c.token)).status, 401);
});

test('at most 3 keys per viewer per deck; another viewer cannot see or revoke them', async (t) => {
  const { r, ada, g, keysPath, createKey } = await setup(t);
  for (const l of ['1', '2', '3']) assert.equal((await createKey(l)).status, 200);
  const fourth = await createKey('4');
  assert.equal(fourth.status, 409);
  assert.match(fourth.data.error, /3 agent keys/);
  const sam = await r.person('sam@keychain.com');
  assert.equal((await sam.call('GET', keysPath)).status, 403, 'no grant, no keys');
  const id = (await g.call('GET', keysPath)).data.keys[0].id;
  assert.equal((await sam.call('DELETE', `${keysPath}/${id}`)).status, 404);
  assert.equal((await g.call('GET', keysPath)).data.keys.length, 3);
  // Cookie writes must come from the relay's own pages.
  assert.equal((await g.call('POST', keysPath, { label: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await g.call('DELETE', `${keysPath}/${id}`, undefined, { Origin: 'https://evil.example' })).status, 403);
  // A deck token is not a viewer session.
  assert.equal((await r.deckCall(ada.token, 'POST', keysPath, { label: 'x' })).status, 401);
});

test('every agent read writes one audit row for the captain; key create/revoke are audited too', async (t) => {
  const { ada, g, keysPath, createKey, agent, audit } = await setup(t);
  const k = (await createKey('ci bot')).data;
  await agent('/v1/agent/library', k.token);
  await agent('/v1/agent/library', k.token);
  await agent(`/v1/agent/library/${ada.sub}/skill:captain:deploy`, k.token);
  await agent(`/v1/agent/library/${ada.sub}/memory:fleet-habits.md`, k.token); // refused: notes off
  // The test clock stands still, so pick the agent rows by text rather than by position.
  const rows = (await audit()).filter((x) => / with agent key /.test(x.what));
  assert.equal(rows.length, 4, 'one row per read, no de-dupe');
  assert.ok(rows.every((x) => x.who === 'grace@keychain.com' && /with agent key "ci bot"$/.test(x.what)));
  assert.deepEqual(rows.map((x) => x.result).sort(), ['agent read', 'agent read', 'agent read', 'refused']);
  assert.ok(rows.some((x) => x.what.startsWith('Skill "Deploy"')));
  assert.ok(rows.some((x) => x.reason === 'notes not shared'));
  await g.call('DELETE', `${keysPath}/${k.key.id}`);
  const all = await audit();
  assert.ok(all.some((x) => x.result === 'key created' && x.what === 'Created agent key "ci bot"'));
  assert.ok(all.some((x) => x.result === 'key revoked'));
  // Unknown keys tell the captain nothing (there is no one to attribute them to).
  const n = all.length;
  await agent('/v1/agent/library', k.token);
  assert.equal((await audit()).length, n);
});

test('rate limit: 60 reads an hour per key, then 429 with Retry-After and one audit row', async (t) => {
  const { r, createKey, agent, audit } = await setup(t);
  const a = (await createKey('a')).data.token;
  const b = (await createKey('b')).data.token;
  for (let i = 0; i < 60; i++) assert.equal((await agent('/v1/agent/library', a)).status, 200);
  const over = await agent('/v1/agent/library', a);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  assert.equal((await agent('/v1/agent/library', a)).status, 429);
  assert.equal((await agent('/v1/agent/library', b)).status, 200, 'per key');
  assert.equal((await audit()).filter((x) => x.result === 'refused' && /reads an hour/.test(x.reason || '')).length, 1);
  r.clock.t += 3600e3;
  assert.equal((await agent('/v1/agent/library', a)).status, 200, 'next hour');
});

test('no write route under /v1/agent: every other method is 405 and nothing changes', async (t) => {
  const { r, ada, createKey, agent } = await setup(t);
  const token = (await createKey()).data.token;
  const paths = ['/v1/agent/library', `/v1/agent/library/${ada.sub}/skill:captain:deploy`];
  for (const p of paths) {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(r.base + p, { method: m, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(LIB) });
      assert.equal(res.status, 405, `${m} ${p}`);
      assert.equal(res.headers.get('allow'), 'GET');
    }
  }
  for (const p of ['/v1/agent', '/v1/agent/keys', '/v1/agent/library/x', '/v1/agent/send', '/v1/agent/orders']) {
    assert.equal((await fetch(r.base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).status, 404, p);
  }
  // An agent key is not a deck token, so it cannot push a library or snapshot either.
  for (const [m, p] of [['POST', '/v1/library'], ['DELETE', '/v1/library'], ['POST', '/v1/snapshot'], ['GET', '/v1/grants']]) {
    assert.equal((await r.deckCall(token, m, p, m === 'POST' ? LIB : undefined)).status, 401, `${m} ${p}`);
  }
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/skill:captain:deploy`, token)).data, '# Deploy\n\nRun the release script.', 'unchanged');
});

test('the relay re-applies the library allow-list and the deck can replace or remove it', async (t) => {
  const { r, ada, createKey, agent } = await setup(t, ['board', 'skills', 'notes']);
  const token = (await createKey()).data.token;
  const s = L.sanitizeLibrary({ ...LIB, home: '/Users/ada', items: [...LIB.items, { key: 'skill:x', title: 't'.repeat(500), text: 'x'.repeat(L.MAX_TEXT + 10), cwd: '/tmp' }] });
  for (const it of s.items) assert.deepEqual(Object.keys(it).sort(), ['description', 'key', 'kind', 'tag', 'text', 'title', 'updatedAt', 'verifiedAt']);
  assert.equal(s.items.at(-1).title.length, 120);
  assert.equal(s.items.at(-1).text.length, L.MAX_TEXT);
  assert.ok(!JSON.stringify(s).includes('/Users/ada'));
  assert.throws(() => L.sanitizeLibrary({ v: 2, items: [] }), /unsupported/);
  assert.equal((await r.deckCall(ada.token, 'POST', '/v1/library', { v: 1, items: 'x' })).status, 400);
  // A new push drops items that are gone.
  await r.deckCall(ada.token, 'POST', '/v1/library', { v: 1, items: [LIB.items[1]] });
  assert.deepEqual((await agent('/v1/agent/library', token)).data.decks[0].items.map((i) => i.key), ['skill:firstmate:review']);
  assert.equal((await agent(`/v1/agent/library/${ada.sub}/skill:captain:deploy`, token)).status, 404);
  // Removed (sharing paused or no grant needs it): the deck shows as offline.
  await r.deckCall(ada.token, 'DELETE', '/v1/library');
  const d = (await agent('/v1/agent/library', token)).data.decks[0];
  assert.equal(d.offline, true);
  assert.deepEqual(d.items, []);
  // Another deck's item path with this key is refused.
  const bob = await r.captain('bob@keychain.com');
  assert.equal((await agent(`/v1/agent/library/${bob.sub}/skill:captain:deploy`, token)).status, 403);
});

test('free-tier budget: an agent read is 6 Redis commands (7 when it stamps last-used)', async (t) => {
  const { r, ada, createKey, agent } = await setup(t);
  const token = (await createKey()).data.token;
  const count = async (fn) => { const n = r.store.stats.commands; await fn(); return r.store.stats.commands - n; };
  assert.equal(await count(() => agent('/v1/agent/library', token)), 7, 'first read also stamps last-used');
  assert.equal(await count(() => agent(`/v1/agent/library/${ada.sub}/skill:captain:deploy`, token)), 6);
  assert.equal(await count(() => agent('/v1/agent/library', 'sdak1.' + ada.sub + '.' + 'A'.repeat(43))), 2, 'an unknown key stops after one round trip');
});
