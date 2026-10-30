'use strict';
// The team pool: anyone on the relay offers a skill or note (redacted by their deck), an approver
// (OWNER_EMAIL, POOL_APPROVERS) approves, and every member's deck syncs it as a read-only teammate
// skill; removing it, or a member turning the pool off, takes it off their computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../relay/lib/pool');
const { createServer, listen } = require('../server');
const { startRelay } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function startDeck(t, relay, name) {
  const dir = tempDir(t);
  fs.cpSync(FIX, path.join(dir, 'home'), { recursive: true });
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const server = createServer({
    home: path.join(dir, 'home'), ordersDir: path.join(dir, 'orders'), claudeDir, memoryDir: null, tmux: false, wake: false, captainName: name,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }), share: true, shareRelay: relay.base, shareNow: () => relay.clock.t,
  });
  const port = await listen(server, 0);
  t.after(() => server.close());
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-Ship-Deck': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { call, dir, skills: path.join(claudeDir, 'skills'), agent: server.shareAgent };
}
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('offers are shaped and capped; keys never look like a captain library key', () => {
  assert.deepEqual(P.sanitizeOffer({ v: 1, item: { kind: 'skill', title: ' Deploy\n', description: 'd', text: 'x', extra: 1 } }), { kind: 'skill', title: 'Deploy', description: 'd', text: 'x' });
  for (const bad of [{}, { v: 1, item: { kind: 'exec', title: 't', text: 'x' } }, { v: 1, item: { kind: 'note', title: '', text: 'x' } }, { v: 1, item: { kind: 'note', title: 't', text: ' ' } }]) assert.throws(() => P.sanitizeOffer(bad));
  assert.equal(P.keyOf({ kind: 'skill', id: 'abc123def' }), 'skill:pool:abc123def');
  assert.equal(P.keyOf({ kind: 'note', id: 'abc123def' }), 'memory:pool:abc123def');
  assert.deepEqual([...P.approvers({ ownerEmail: 'o@k.com', poolApprovers: ' A@k.com, ,b@k.com' })], ['o@k.com', 'a@k.com', 'b@k.com']);
});

test('end to end: offer, approve, sync to every member, remove, opt out; only approvers approve', async (t) => {
  const relay = await startRelay(t, { env: { OWNER_EMAIL: 'owner@keychain.com' } });
  const people = await Promise.all(['owner', 'ada', 'grace'].map((n) => relay.person(n + '@keychain.com')));
  const [owner, ada, grace] = await Promise.all(['Owner', 'Ada', 'Grace'].map((n) => startDeck(t, relay, n)));
  for (const [deck, p] of [[owner, people[0]], [ada, people[1]], [grace, people[2]]]) assert.equal((await deck.call('POST', '/api/share/signin', { email: p.email, password: p.password })).status, 200);
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: How we ship\n---\n# Deploy\nexport GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsee ${ada.dir}/home\n`);
  fs.mkdirSync(path.join(ada.dir, 'home', 'data'), { recursive: true });
  fs.writeFileSync(path.join(ada.dir, 'home', 'data', 'learnings.md'), 'Private things.\n');
  await ada.call('POST', '/api/share/item', { key: 'home:data/learnings.md', tag: 'private' });

  // Before any approval the pool costs members nothing: no pool deck, no extra command.
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(!fs.existsSync(grace.skills));

  // Ada offers her skill (redacted on her deck); a private note cannot be offered.
  let r = await ada.call('POST', '/api/share/pool', { action: 'offer', key: 'skill:captain:deploy' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.pool.pending.map((x) => [x.title, x.mine]), [['deploy', true]]);
  const pendingText = r.data.pool.pending[0].text;
  assert.ok(!pendingText.includes('ghp_') && !pendingText.includes(ada.dir) && pendingText.includes('[token hidden]'), 'redacted before it left');
  assert.equal((await ada.call('POST', '/api/share/pool', { action: 'offer', key: 'home:data/learnings.md' })).status, 400);
  assert.equal((await ada.call('POST', '/api/share/pool', { action: 'offer', key: 'home:AGENTS.md' })).status, 400);

  // Grace sees no pending offer of Ada's and cannot approve it; the owner sees it with its text.
  const id = r.data.pool.pending[0].id;
  assert.deepEqual((await grace.call('GET', '/api/share/pool')).data.pending, []);
  assert.equal((await grace.call('POST', '/api/share/pool', { action: 'approve', id })).status, 403);
  assert.equal((await grace.call('POST', '/api/share/pool', { action: 'decline', id })).status, 403);
  const seen = (await owner.call('GET', '/api/share/pool')).data;
  assert.equal(seen.approver, true);
  assert.equal(seen.pending[0].text, pendingText);
  relay.clock.t += 10 * 60e3;
  await grace.agent.syncKnowledge();
  assert.ok(!fs.existsSync(grace.skills), 'nothing reaches anyone before approval');

  // Approved: every member's next sync writes it, with who offered and approved it.
  r = await owner.call('POST', '/api/share/pool', { action: 'approve', id });
  assert.deepEqual(r.data.pool.items.map((x) => [x.title, x.by, x.approvedBy]), [['deploy', 'ada@keychain.com', 'owner@keychain.com']]);
  assert.deepEqual(r.data.pool.pending, []);
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  const text = read(grace.skills, 'teammate-team-pool-deploy', 'SKILL.md');
  assert.match(text, /> Shared by Team pool via Ship Deck on 2026-10-14; [^\n]*\n> Offered by ada@keychain\.com, approved by owner@keychain\.com\./);
  assert.ok(text.includes('[token hidden]') && !text.includes('ghp_'));
  assert.equal(await ada.agent.syncKnowledge(), 'synced');
  assert.ok(fs.existsSync(path.join(ada.skills, 'teammate-team-pool-deploy')), 'its author gets it too');
  const k = (await grace.call('GET', '/api/share')).data.knowledge;
  assert.equal(k.decks[0].name, 'Team pool');
  // Logged for the approver and the author.
  const ownerLog = (await owner.call('GET', '/api/share/audit')).data.rows.map((x) => x.what);
  assert.ok(ownerLog.includes('Offered "deploy" to the team pool') && ownerLog.includes('Approved "deploy" from ada@keychain.com for the team pool'));
  assert.ok(ownerLog.includes('Team pool synced to their agent: 1 item'));
  assert.ok((await ada.call('GET', '/api/share/audit')).data.rows.some((x) => x.result === 'approved'));
  // Grace's own shares never pass it on.
  await grace.call('POST', '/api/share/grant', { email: 'ada@keychain.com', scopes: ['skills'], projects: ['*'] });
  await grace.agent.tick();
  const [, libKeys] = await relay.store.cmd(['SCAN', '0', 'MATCH', 'lib:*']);
  for (const lk of libKeys) assert.ok(!JSON.parse(await relay.store.cmd(['HGET', lk, 'index'])).items.some((i) => i.key.includes('team-pool')));

  // Grace turns the pool off: removed at once and not written again.
  r = await grace.call('POST', '/api/share/pool', { action: 'use', on: false });
  assert.equal(r.data.status.knowledge.pool, false);
  assert.ok(!fs.existsSync(path.join(grace.skills, 'teammate-team-pool-deploy')));
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(!fs.existsSync(path.join(grace.skills, 'teammate-team-pool-deploy')));

  // The owner removes it: gone from Ada's computer on her next sync. Only approvers remove.
  assert.equal((await ada.call('POST', '/api/share/pool', { action: 'remove', id })).status, 403);
  await owner.call('POST', '/api/share/pool', { action: 'remove', id });
  relay.clock.t += 10 * 60e3;
  assert.equal(await ada.agent.syncKnowledge(), 'synced');
  assert.ok(!fs.existsSync(path.join(ada.skills, 'teammate-team-pool-deploy')));

  // An author can withdraw their own offer.
  r = await ada.call('POST', '/api/share/pool', { action: 'offer', key: 'skill:captain:deploy' });
  r = await ada.call('POST', '/api/share/pool', { action: 'decline', id: r.data.pool.pending[0].id });
  assert.deepEqual(r.data.pool.pending, []);
  assert.ok((await owner.call('GET', '/api/share/audit')).data.rows.some((x) => x.result === 'withdrawn'));
});

test('without an approver the pool is off; outsiders and bad ids are refused', async (t) => {
  const relay = await startRelay(t);
  const ada = await relay.captain('ada@keychain.com');
  assert.equal((await relay.deckCall(ada.token, 'GET', '/v1/pool')).status, 404);
  assert.equal((await relay.deckCall(null, 'GET', '/v1/pool')).status, 401);
  const r2 = await startRelay(t, { env: { OWNER_EMAIL: 'owner@keychain.com' } });
  const bob = await r2.captain('bob@keychain.com');
  assert.equal((await r2.deckCall(bob.token, 'POST', '/v1/pool/offers', { v: 1, item: { kind: 'exec', title: 't', text: 'x' } })).status, 400);
  assert.equal((await r2.deckCall(bob.token, 'POST', '/v1/pool/offers/nope!/approve')).status, 404);
  assert.equal((await r2.deckCall(bob.token, 'GET', '/v1/pool/offers')).status, 405);
  for (let i = 0; i < P.MAX_PER_PERSON; i++) assert.equal((await r2.deckCall(bob.token, 'POST', '/v1/pool/offers', { v: 1, item: { kind: 'note', title: 'n' + i, text: 'x' } })).status, 200);
  assert.equal((await r2.deckCall(bob.token, 'POST', '/v1/pool/offers', { v: 1, item: { kind: 'note', title: 'one more', text: 'x' } })).status, 409);
});
