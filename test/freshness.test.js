'use strict';
// Freshness and note tags: every shared skill and note carries when the captain last updated and
// verified it, items unchecked for N days are flagged on both sides, private notes never leave the
// deck, and a grant can carry only the notes marked Share.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../lib/knowledge');
const share = require('../lib/share');
const RL = require('../relay/lib/library');
const { validateGrant } = require('../relay/lib/access');
const { viewFor } = require('../relay/lib/snapshot');
const { createServer, listen } = require('../server');
const { startRelay } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');
const DAY = 86400e3;
const AT = Date.parse('2026-10-14T12:00:00Z');
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('freshness: editing counts as checking; flagged after N days; never stale without dates', () => {
  assert.deepEqual(K.freshness({ updatedAt: AT - 5 * DAY }, 'Ada', AT), { line: 'Last updated 2026-10-09, not marked verified.', stale: false, staleAt: AT + 25 * DAY });
  const old = K.freshness({ updatedAt: AT - 60 * DAY, verifiedAt: AT - 40 * DAY }, 'Ada', AT);
  assert.equal(old.stale, true);
  assert.match(old.line, /^Last updated 2026-08-15, last verified 2026-09-04\. Ada has not checked it in over 30 days/);
  assert.equal(K.freshness({ updatedAt: AT - 60 * DAY, verifiedAt: AT - 2 * DAY }, 'Ada', AT).stale, false, 'a recent verify makes it fresh');
  assert.equal(K.freshness({ updatedAt: AT - 10 * DAY }, 'Ada', AT, 7).stale, true, 'N is configurable');
  assert.deepEqual(K.freshness({}, 'Ada', AT), { line: '', stale: false, staleAt: null });

  const plan = K.planDeck({ captainSub: 'adaSub000001', name: 'Ada', items: [
    { key: 'skill:captain:deploy', kind: 'skill', title: 'deploy', text: '# Deploy', updatedAt: AT - 90 * DAY },
    { key: 'memory:a.md', kind: 'note', title: 'A', text: 'fresh', updatedAt: AT - DAY },
  ] }, 'ada', AT);
  assert.equal(plan[0].stale, false);
  assert.equal(plan[0].staleAt, AT + 29 * DAY);
  assert.match(plan[0].text, /## A\n\n_Last updated 2026-10-13, not marked verified\._\n\nfresh/);
  assert.equal(plan[1].stale, true);
  assert.match(plan[1].text, /> Shared by Ada via Ship Deck on 2026-10-14; [^\n]*\n> Last updated 2026-07-16, not marked verified\. Ada has not checked it in over 30 days/);
  assert.equal(K.nextStale(plan), AT + 29 * DAY);
});

test('projection: private notes never leave, Share tags and dates travel, skills cannot be tagged', () => {
  const lib = share.projectLibrary([
    { key: 'skill:captain:x', title: 'x', text: 'x', updatedAt: 5, verifiedAt: 6, tag: 'share' },
    { key: 'memory:a.md', title: 'a', text: 'public', tag: 'share', updatedAt: 7 },
    { key: 'memory:b.md', title: 'b', text: 'secret plans', tag: 'private' },
    { key: 'memory:c.md', title: 'c', text: 'plain' },
  ], { notes: true });
  assert.deepEqual(lib.items.map((i) => [i.key, i.tag, i.updatedAt, i.verifiedAt]), [['skill:captain:x', null, 5, 6], ['memory:a.md', 'share', 7, null], ['memory:c.md', null, null, null]]);
  assert.ok(!JSON.stringify(lib).includes('secret plans'));
  const snap = share.projectSnapshot({ tasks: [] }, { scopes: ['notes'], projects: ['*'], extras: { notes: [{ key: 'memory:a.md', title: 'a', text: 'public', tag: 'share' }, { key: 'memory:b.md', title: 'b', text: 'secret plans', tag: 'private' }] } });
  assert.deepEqual(snap.notes.map((n) => [n.key, n.tag]), [['memory:a.md', 'share']]);
});

test('relay: notesTagged grants get only notes marked Share, everywhere they are read', () => {
  const g = validateGrant('grace@keychain.com', { scopes: ['notes'], projects: ['*'], notesTagged: true }, { domain: 'keychain.com', now: AT });
  assert.equal(g.notesTagged, true);
  assert.equal(validateGrant('grace@keychain.com', { scopes: ['skills'], projects: ['*'], notesTagged: true }, { domain: 'keychain.com', now: AT }).notesTagged, false, 'only with notes');
  const all = { ...g, notesTagged: false };
  assert.equal(RL.itemAllowed({ key: 'memory:a.md', tag: 'share' }, g), true);
  assert.equal(RL.itemAllowed({ key: 'memory:c.md', tag: null }, g), false);
  assert.equal(RL.itemAllowed({ key: 'memory:c.md', tag: null }, all), true);
  assert.notEqual(RL.knowledgeHash([{ key: 'memory:c.md', h: 'x' }], g), RL.knowledgeHash([{ key: 'memory:c.md', h: 'x' }], all));
  const snap = { workers: [], notes: [{ key: 'memory:a.md', tag: 'share' }, { key: 'memory:c.md' }] };
  assert.deepEqual(viewFor(snap, g, 'notes').data.notes.map((n) => n.key), ['memory:a.md']);
  assert.deepEqual(viewFor(snap, all, 'notes').data.notes.map((n) => n.key), ['memory:a.md', 'memory:c.md']);
  const s = RL.sanitizeLibrary({ v: 1, items: [{ key: 'skill:x', title: 'x', text: 'x', tag: 'share', updatedAt: 'soon' }, { key: 'memory:a.md', title: 'a', text: 'a', tag: 'share', updatedAt: 9 }] });
  assert.deepEqual(s.index.map((i) => [i.tag, i.updatedAt]), [[null, null], ['share', 9]]);
});

async function startDeck(t, relay, name, extra = {}) {
  const dir = tempDir(t);
  fs.cpSync(FIX, path.join(dir, 'home'), { recursive: true });
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const server = createServer({
    home: path.join(dir, 'home'), ordersDir: path.join(dir, 'orders'), claudeDir, memoryDir: null, tmux: false, wake: false, captainName: name,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }), share: true, shareRelay: relay.base, shareNow: () => relay.clock.t, ...extra,
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

test('end to end: verify, tags and stale flags on both sides', async (t) => {
  const relay = await startRelay(t);
  const people = await Promise.all(['ada', 'grace', 'sam'].map((n) => relay.person(n + '@keychain.com')));
  // Grace flags what is unchecked for 7 days (her own --verify-days); the others use the default 30.
  const [ada, grace, sam] = await Promise.all(['Ada', 'Grace', 'Sam'].map((n) => startDeck(t, relay, n, n === 'Grace' ? { verifyDays: 7 } : {})));
  const data = path.join(ada.dir, 'home', 'data');
  fs.mkdirSync(data, { recursive: true });
  const old = new Date(relay.clock.t - 90 * DAY);
  for (const [f, text] of [['captain.md', 'Tagged share.'], ['captain-shared.md', 'Untagged.'], ['learnings.md', 'PRIVATE learnings.']]) {
    fs.writeFileSync(path.join(data, f), text + '\n');
    fs.utimesSync(path.join(data, f), old, old);
  }
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\n---\n# Deploy\n');
  fs.utimesSync(path.join(ada.skills, 'deploy', 'SKILL.md'), old, old);
  for (const [deck, p] of [[ada, people[0]], [grace, people[1]], [sam, people[2]]]) await deck.call('POST', '/api/share/signin', { email: p.email, password: p.password });

  // The sharer's list: everything a grant could carry, stale (90 days old, never verified).
  let items = (await ada.call('GET', '/api/share/items')).data.items;
  const pick = (key) => items.find((i) => i.key === key);
  for (const key of ['home:data/captain.md', 'home:data/captain-shared.md', 'home:data/learnings.md', 'skill:captain:deploy']) assert.equal(pick(key).stale, true, key);
  assert.deepEqual([pick('home:data/captain.md').kind, pick('skill:captain:deploy').kind], ['note', 'skill']);
  assert.ok(!items.some((i) => i.key === 'home:AGENTS.md'), 'only what a grant could carry');
  await ada.call('POST', '/api/share/item', { key: 'home:data/captain.md', tag: 'share' });
  await ada.call('POST', '/api/share/item', { key: 'home:data/learnings.md', tag: 'private' });
  assert.equal((await ada.call('POST', '/api/share/item', { key: 'skill:captain:deploy', tag: 'share' })).status, 400, 'skills are not tagged');
  assert.equal((await ada.call('POST', '/api/share/item', { key: 'home:AGENTS.md', verified: true })).status, 400, 'only shareable items');
  assert.equal((await ada.call('POST', '/api/share/item', { key: 'home:data/captain.md', tag: 'secret' })).status, 400);

  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'skills', 'notes'], projects: ['*'], notesTagged: true });
  await ada.call('POST', '/api/share/grant', { email: 'sam@keychain.com', scopes: ['notes'], projects: ['*'] });
  assert.equal((await ada.call('GET', '/api/share/grants')).data.grants.find((g) => g.viewerEmail === 'grace@keychain.com').notesTagged, true);
  await ada.agent.tick();
  // The private note never reached the relay, in the library or the snapshot.
  const [, keys] = await relay.store.cmd(['SCAN', '0', 'MATCH', '*']);
  for (const k of keys) {
    const v = JSON.stringify(await relay.store.cmd([(k.startsWith('lib:') ? 'HGETALL' : 'GET'), k]).catch(() => null));
    assert.ok(!v || !v.includes('PRIVATE learnings'), k);
  }

  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.equal(await sam.agent.syncKnowledge(), 'synced');
  const graceNotes = read(grace.skills, 'teammate-ada-notes', 'SKILL.md');
  assert.ok(graceNotes.includes('Tagged share.') && !graceNotes.includes('Untagged.'), 'Grace: only notes marked Share');
  const samNotes = read(sam.skills, 'teammate-ada-notes', 'SKILL.md');
  assert.ok(samNotes.includes('Tagged share.') && samNotes.includes('Untagged.') && !samNotes.includes('PRIVATE'), 'Sam: every note but the private one');
  assert.match(read(grace.skills, 'teammate-ada-deploy', 'SKILL.md'), /Ada has not checked it in over 7 days/);
  let k = (await grace.call('GET', '/api/share')).data.knowledge.decks[0];
  assert.equal(k.skills.find((s) => s.dir === 'teammate-ada-deploy').stale, true, "flagged in the receiver's Settings");
  assert.equal(k.notesStale, true);

  // Ada verifies the skill: fresh again on both sides after the next push and sync.
  items = (await ada.call('POST', '/api/share/item', { key: 'skill:captain:deploy', verified: true })).data.items;
  assert.equal(items.find((i) => i.key === 'skill:captain:deploy').stale, false);
  assert.equal(items.find((i) => i.key === 'skill:captain:deploy').verifiedAt, relay.clock.t);
  relay.clock.t += 61e3;
  await ada.agent.tick();
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  let skill = read(grace.skills, 'teammate-ada-deploy', 'SKILL.md');
  assert.match(skill, /last verified 2026-10-14\./);
  assert.ok(!skill.includes('has not checked'));

  // 8 days later, with nothing changed on Ada's side, Grace's copy turns stale on its own.
  relay.clock.t += 8 * DAY;
  await ada.agent.tick(); // the library keep-alive (same content, no new version)
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.match(read(grace.skills, 'teammate-ada-deploy', 'SKILL.md'), /Ada has not checked it in over 7 days/);
  k = (await grace.call('GET', '/api/share')).data.knowledge.decks[0];
  assert.equal(k.skills.find((s) => s.dir === 'teammate-ada-deploy').stale, true);
});
