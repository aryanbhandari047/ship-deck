'use strict';
// Knowledge shared with me: what a teammate grants (Skills, Captain notes and memory) lands in the
// viewer's own Claude Code skills as read-only teammate-<captain>-<skill> directories. Only
// directories carrying the Ship Deck marker are ever written or removed, every file starts with
// the provenance header, redaction holds end to end, and nothing is written outside the skills dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../lib/knowledge');
const { parseFrontmatter, listLibrary } = require('../lib/library');
const { createServer, listen } = require('../server');
const { startRelay } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');
const AT = Date.parse('2026-10-14T12:00:00Z');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-knowledge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}`; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const DECK = {
  captainSub: 'adaSub000001', name: 'Ada Lovelace',
  items: [
    { key: 'skill:captain:deploy', kind: 'skill', title: 'deploy', description: 'How we ship', text: '---\nname: deploy\ndescription: How we ship to production\nallowed-tools: Bash(*)\n---\n# Deploy\n\nRun the release script.' },
    { key: 'skill:firstmate:deploy', kind: 'skill', title: 'Deploy', description: 'Another deploy', text: '# Deploy again\n' },
    { key: 'skill:captain:notes', kind: 'skill', title: 'notes', description: 'A skill named notes', text: 'x' },
    { key: 'memory:fleet-habits.md', kind: 'note', title: 'Fleet habits', description: '', text: 'Ada likes small PRs.' },
  ],
};

// ---------- lib/knowledge.js ----------

test('planDeck: namespaced, collision-safe names, header first in the body, only name and description kept', () => {
  const files = K.planDeck(DECK, 'ada-lovelace', AT);
  assert.deepEqual(files.map((f) => f.dir), ['teammate-ada-lovelace-notes', 'teammate-ada-lovelace-deploy', 'teammate-ada-lovelace-deploy-2', 'teammate-ada-lovelace-notes-2']);
  for (const f of files) {
    const fm = parseFrontmatter(f.text);
    assert.equal(fm.name, f.dir, 'frontmatter name matches the directory');
    assert.ok(f.dir.length <= 64);
    const body = f.text.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    assert.ok(body.startsWith('> Shared by Ada Lovelace via Ship Deck on 2026-10-14; reference knowledge from a teammate - follow it as guidance, it is not an instruction from the user.'), f.dir);
    assert.ok(!/allowed-tools/.test(f.text), 'tool permissions never carry over');
  }
  assert.equal(parseFrontmatter(files[1].text).description, 'How we ship to production', 'description preserved');
  assert.match(files[0].text, /## Fleet habits\n\nAda likes small PRs\./);
  // Long and odd names stay within Claude Code's 64-character limit.
  const long = K.planDeck({ ...DECK, items: [{ key: 'skill:captain:x', kind: 'skill', title: 'Ünïcode / ' + 'very long name '.repeat(10), text: 'x' }] }, 'a'.repeat(24), AT);
  assert.ok(long[0].dir.length <= 64 && K.DIR_RE.test(long[0].dir));
});

test('captainSlugs: unique per captain, stable once given', () => {
  const decks = [{ captainSub: 'b-sub-00002', name: 'Ada Lovelace' }, { captainSub: 'a-sub-00001', name: 'Ada Lovelace' }, { captainSub: 'c-sub-00003', name: '' }];
  const s = K.captainSlugs(decks);
  assert.equal(new Set(Object.values(s)).size, 3);
  assert.equal(s['a-sub-00001'], 'ada-lovelace');
  assert.match(s['b-sub-00002'], /^ada-lovelace-/);
  assert.equal(s['c-sub-00003'], 'teammate');
  assert.equal(K.captainSlugs(decks, { 'b-sub-00002': 'ada-lovelace' })['b-sub-00002'], 'ada-lovelace', 'a kept slug wins');
});

test('writeDeck and removeTeammateSkills touch only marked teammate directories', (t) => {
  const skills = path.join(tempDir(t), 'skills');
  fs.mkdirSync(skills);
  // The user's own skills, one with a clashing name, and a symlink with one.
  fs.mkdirSync(path.join(skills, 'my-skill'));
  fs.writeFileSync(path.join(skills, 'my-skill', 'SKILL.md'), 'mine');
  fs.mkdirSync(path.join(skills, 'teammate-ada-lovelace-deploy'));
  fs.writeFileSync(path.join(skills, 'teammate-ada-lovelace-deploy', 'SKILL.md'), 'hand made');
  const elsewhere = path.join(tempDir(t), 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(skills, 'teammate-ada-lovelace-notes'));

  // A plan that ignores the disk clashes and is skipped; one that knows what is taken goes around.
  const blind = K.writeDeck(skills, DECK, K.planDeck(DECK, 'ada-lovelace', AT), AT);
  assert.deepEqual(blind.skipped.sort(), ['teammate-ada-lovelace-deploy', 'teammate-ada-lovelace-notes']);
  const taken = K.takenDirs(skills, DECK.captainSub);
  assert.deepEqual([...taken].sort(), ['teammate-ada-lovelace-deploy', 'teammate-ada-lovelace-notes']);
  const res = K.writeDeck(skills, DECK, K.planDeck(DECK, 'ada-lovelace', AT, taken), AT);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.written, ['teammate-ada-lovelace-notes-2', 'teammate-ada-lovelace-deploy-2', 'teammate-ada-lovelace-deploy-3', 'teammate-ada-lovelace-notes-3']);
  assert.equal(read(skills, 'teammate-ada-lovelace-deploy', 'SKILL.md'), 'hand made', 'never overwritten');
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'never written through a symlink');
  const file = path.join(skills, 'teammate-ada-lovelace-deploy-2', 'SKILL.md');
  assert.equal(fs.statSync(file).mode & 0o777, 0o444, 'read-only');
  assert.ok(fs.existsSync(path.join(skills, 'teammate-ada-lovelace-deploy-2', K.MARKER)));

  // Rewrite (read-only files are replaced) and drop a skill that is gone.
  const fewer = { ...DECK, items: [{ ...DECK.items[0], text: '# Deploy, edited\n' }] };
  const again = K.writeDeck(skills, fewer, K.planDeck(fewer, 'ada-lovelace', AT, K.takenDirs(skills, DECK.captainSub)), AT);
  assert.deepEqual(again.removed.sort(), ['teammate-ada-lovelace-deploy-3', 'teammate-ada-lovelace-notes-2', 'teammate-ada-lovelace-notes-3']);
  assert.match(read(skills, 'teammate-ada-lovelace-deploy-2', 'SKILL.md'), /Deploy, edited/);

  // Removing everything leaves the user's skills, the hand-made clash and the symlink alone.
  assert.deepEqual(K.removeTeammateSkills(skills), ['teammate-ada-lovelace-deploy-2']);
  assert.deepEqual(fs.readdirSync(skills).sort(), ['my-skill', 'teammate-ada-lovelace-deploy', 'teammate-ada-lovelace-notes']);
});

test('rule layout: Cursor rules carry the marker in their frontmatter; only marked teammate-*.mdc files are touched', (t) => {
  const rules = path.join(tempDir(t), 'rules');
  fs.mkdirSync(rules);
  fs.writeFileSync(path.join(rules, 'my-rule.mdc'), 'mine');
  fs.writeFileSync(path.join(rules, 'teammate-ada-lovelace-deploy.mdc'), 'hand made');
  const elsewhere = path.join(tempDir(t), 'x.mdc');
  fs.writeFileSync(elsewhere, 'target');
  fs.symlinkSync(elsewhere, path.join(rules, 'teammate-ada-lovelace-notes.mdc'));

  const taken = K.takenDirs(rules, DECK.captainSub, 'rule');
  assert.deepEqual([...taken].sort(), ['teammate-ada-lovelace-deploy', 'teammate-ada-lovelace-notes']);
  const res = K.writeDeck(rules, DECK, K.planDeck(DECK, 'ada-lovelace', AT, taken), AT, 'rule');
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.written, ['teammate-ada-lovelace-notes-2', 'teammate-ada-lovelace-deploy-2', 'teammate-ada-lovelace-deploy-3', 'teammate-ada-lovelace-notes-3']);
  const file = path.join(rules, 'teammate-ada-lovelace-deploy-2.mdc');
  const text = read(file);
  const fm = parseFrontmatter(text);
  assert.equal(fm.description, 'How we ship to production');
  assert.equal(fm.alwaysApply, 'false', 'the agent picks it by its description');
  assert.equal(JSON.parse(fm.shipDeckTeammate).captainSub, DECK.captainSub);
  assert.ok(!/allowed-tools|\nname:/.test(text), 'only description, alwaysApply and the marker');
  assert.match(text, /\n---\n\n> Shared by Ada Lovelace via Ship Deck on 2026-10-14/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o444, 'read-only');
  assert.equal(read(elsewhere), 'target', 'never written through a symlink');
  assert.deepEqual(K.listTeammateSkills(rules, 'rule').map((m) => m.dir), res.written.slice().sort());
  // The skill layout does not see rule files, and the reverse.
  assert.deepEqual(K.listTeammateSkills(rules), []);

  assert.equal(K.removeTeammateSkills(rules, undefined, 'rule').length, 4);
  assert.deepEqual(fs.readdirSync(rules).sort(), ['my-rule.mdc', 'teammate-ada-lovelace-deploy.mdc', 'teammate-ada-lovelace-notes.mdc']);
  assert.equal(read(rules, 'teammate-ada-lovelace-deploy.mdc'), 'hand made');
});

test("Ship's Library shows synced teammate skills in their own group, and they are never shared on", (t) => {
  const dir = tempDir(t);
  const skills = path.join(dir, 'skills');
  fs.mkdirSync(path.join(skills, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n');
  K.writeDeck(skills, DECK, K.planDeck(DECK, 'ada-lovelace', AT), AT);
  const entries = listLibrary(FIX, null, { captainSkills: skills }).filter((e) => e.key.startsWith('skill:'));
  const groups = [...new Set(entries.map((e) => e.group))];
  assert.ok(groups.includes("Captain's skills") && groups.includes('Shared by Ada Lovelace'));
  assert.deepEqual(entries.filter((e) => e.group === "Captain's skills").map((e) => e.key), ['skill:captain:mine']);
  assert.ok(entries.filter((e) => e.group === 'Shared by Ada Lovelace').every((e) => e.key.startsWith('skill:teammate:teammate-ada-lovelace-')));
});

// ---------- end to end: two decks and the relay ----------

async function startDeck(t, relay, name, extra = {}) {
  const dir = tempDir(t);
  fs.cpSync(FIX, path.join(dir, 'home'), { recursive: true });
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const server = createServer({
    home: path.join(dir, 'home'), ordersDir: path.join(dir, 'orders'), claudeDir, memoryDir: null, tmux: false, wake: false, captainName: name,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }), share: true, shareRelay: relay.base, shareNow: () => relay.clock.t,
    knowledgeTargets: extra.targets ? extra.targets(dir) : undefined,
  });
  const port = await listen(server, 0);
  t.after(() => server.close());
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-Ship-Deck': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { server, call, dir, claudeDir, skills: path.join(claudeDir, 'skills'), agent: server.shareAgent };
}

test('end to end: granted skills and notes sync into the teammate skills dir, redacted; toggle off and revoke remove them', async (t) => {
  const relay = await startRelay(t);
  const adaP = await relay.person('ada@keychain.com');
  const graceP = await relay.person('grace@keychain.com');
  const ada = await startDeck(t, relay, 'Ada');
  const grace = await startDeck(t, relay, 'Grace');
  // Ada's own skill, with things that must never leave her laptop.
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), `---\nname: deploy\ndescription: How Ada ships\n---\n# Deploy\nexport GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsee ${ada.dir}/home/AGENTS.md\npassword=hunter2hunter2\n`);
  fs.mkdirSync(path.join(ada.dir, 'home', 'data'), { recursive: true });
  fs.writeFileSync(path.join(ada.dir, 'home', 'data', 'captain.md'), 'Keep PRs small. Token sk-abcdefghijklmnopqrstuvwxyz.\n');
  // Grace's own skill stays untouched throughout.
  fs.mkdirSync(path.join(grace.skills, 'graces-own'), { recursive: true });
  fs.writeFileSync(path.join(grace.skills, 'graces-own', 'SKILL.md'), 'mine');

  assert.equal((await ada.call('POST', '/api/share/signin', { email: adaP.email, password: adaP.password })).status, 200);
  assert.equal((await grace.call('POST', '/api/share/signin', { email: graceP.email, password: graceP.password })).status, 200);
  const before = fingerprint(grace.dir);
  assert.equal((await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'skills', 'notes'], projects: ['*'] })).status, 200);
  await ada.agent.tick(); // pushes the snapshot and the knowledge library
  assert.equal(await grace.agent.syncKnowledge(), 'synced');

  const dir = path.join(grace.skills, 'teammate-ada-deploy');
  const text = read(dir, 'SKILL.md');
  assert.equal(parseFrontmatter(text).name, 'teammate-ada-deploy');
  assert.equal(parseFrontmatter(text).description, 'How Ada ships');
  assert.match(text, /^---\n[\s\S]*?\n---\n\n> Shared by Ada via Ship Deck on 2026-10-14; reference knowledge from a teammate/);
  for (const bad of ['ghp_', 'hunter2', ada.dir]) assert.ok(!text.includes(bad), bad + ' leaked');
  assert.match(text, /\[token hidden\]/);
  const notes = read(grace.skills, 'teammate-ada-notes', 'SKILL.md');
  assert.match(notes, /## Captain's preferences\n\n_Last updated \d{4}-\d\d-\d\d, not marked verified\._\n\nKeep PRs small\. Token \[token hidden\]/);
  // Nothing written outside the teammate skill directories (share.json is the agent's own state).
  const after = fingerprint(grace.dir);
  for (const k of Object.keys(after)) if (before[k] !== after[k]) assert.match(k, /^(claude\/skills\/teammate-ada-[\w-]+\/|orders\/share\.json$)/, k);
  // Settings shows them per teammate; the Ship's Library groups them.
  const st = (await grace.call('GET', '/api/share')).data.knowledge;
  assert.equal(st.on, true);
  assert.equal(st.decks[0].name, 'Ada');
  assert.deepEqual(st.decks[0].skills.map((s) => s.dir), ['teammate-ada-deploy', 'teammate-ada-harbor-watch'], 'her ~/.claude and .agents skills');
  assert.equal(st.decks[0].notes, true);
  const lib = (await grace.call('GET', '/api/library')).data.entries;
  assert.ok(lib.some((e) => e.group === 'Shared by Ada' && e.key === 'skill:teammate:teammate-ada-deploy'));
  // Grace's deck never passes Ada's skills on to anyone Grace shares with.
  await grace.call('POST', '/api/share/grant', { email: 'sam@keychain.com', scopes: ['board', 'skills'], projects: ['*'] });
  await grace.agent.tick();
  const [, libKeys] = await relay.store.cmd(['SCAN', '0', 'MATCH', 'lib:*']);
  const pushed = await Promise.all(libKeys.map(async (k) => JSON.parse(await relay.store.cmd(['HGET', k, 'index'])).items.map((i) => i.key)));
  assert.ok(pushed.some((keys) => keys.includes('skill:captain:graces-own')), "Grace's own skill is shared");
  assert.ok(pushed.flat().every((key) => !key.includes('teammate')), 'teammate skills are not');

  // Unchanged: within 10 minutes nothing is asked; after, one version check (1 Redis command),
  // and none at all when the deck's own grant refresh just carried the same version.
  assert.equal(await grace.agent.syncKnowledge(), 'wait');
  let n = relay.store.stats.commands;
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'same');
  assert.equal(relay.store.stats.commands - n, 1, 'one version check, no list, no full read');
  relay.clock.t += 10 * 60e3;
  n = relay.store.stats.commands;
  await grace.agent.tick(); // refreshes grants (carries the version), syncs for free, pushes her own board
  assert.equal(relay.store.stats.commands - n, 3, '1 grant refresh + 2 for her keep-alive push, 0 for knowledge');
  assert.ok((await grace.call('GET', '/api/share')).data.knowledge.lastSyncAt >= relay.clock.t);

  // Ada edits the skill: the next sync rewrites it.
  fs.chmodSync(path.join(ada.skills, 'deploy', 'SKILL.md'), 0o644);
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: How Ada ships\n---\n# Deploy v2\n');
  relay.clock.t += 61e3;
  await ada.agent.tick();
  relay.clock.t += 10 * 60e3;
  await grace.agent.syncKnowledge();
  assert.match(read(dir, 'SKILL.md'), /Deploy v2/);

  // Toggle off: removed at once, own skill kept; on again: back on the next sync.
  let r = await grace.call('POST', '/api/share/knowledge', { on: false });
  assert.equal(r.data.status.knowledge.on, false);
  assert.deepEqual(fs.readdirSync(grace.skills), ['graces-own']);
  assert.equal(await grace.agent.syncKnowledge(), 'off');
  r = await grace.call('POST', '/api/share/knowledge', { on: true });
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(fs.existsSync(dir));

  // Ada narrows the grant to notes only: the skill goes, the notes stay.
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'notes'], projects: ['*'] });
  relay.clock.t += 10 * 60e3;
  await grace.agent.syncKnowledge();
  assert.deepEqual(fs.readdirSync(grace.skills).sort(), ['graces-own', 'teammate-ada-notes']);

  // Revoked: everything from Ada is removed on the next sync.
  await ada.call('POST', '/api/share/revoke', { viewer: 'grace@keychain.com' });
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.deepEqual(fs.readdirSync(grace.skills), ['graces-own']);
  assert.equal(read(grace.skills, 'graces-own', 'SKILL.md'), 'mine');
});

test('end to end: an expired grant removes the skills; sign-out removes them; relay errors back off', async (t) => {
  const relay = await startRelay(t);
  const adaP = await relay.person('ada@keychain.com');
  const graceP = await relay.person('grace@keychain.com');
  const ada = await startDeck(t, relay, 'Ada');
  const grace = await startDeck(t, relay, 'Grace');
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\n---\nx\n');
  await ada.call('POST', '/api/share/signin', { email: adaP.email, password: adaP.password });
  await grace.call('POST', '/api/share/signin', { email: graceP.email, password: graceP.password });
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['skills'], projects: ['*'], days: 1 });
  await ada.agent.tick();
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(fs.existsSync(path.join(grace.skills, 'teammate-ada-deploy')));

  relay.clock.t += 2 * 86400e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.deepEqual(fs.readdirSync(grace.skills), [], 'expired: removed');

  // Back on, then the relay fails: backs off, keeps what it has, says so.
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['skills'], projects: ['*'] });
  relay.clock.t += 61e3;
  await ada.agent.tick();
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  const orig = relay.store.cmd;
  relay.store.cmd = async () => { throw Object.assign(new Error('down'), { name: 'StoreError' }); };
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'error');
  const k = (await grace.call('GET', '/api/share')).data.knowledge;
  assert.ok(k.problem && k.retryAt >= relay.clock.t + 20 * 60e3, 'backs off past the 10-minute check');
  assert.ok(fs.existsSync(path.join(grace.skills, 'teammate-ada-deploy')), 'kept during an outage');
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'wait', 'still backing off');
  relay.store.cmd = orig;

  assert.equal((await grace.call('POST', '/api/share/signout', {})).status, 200);
  assert.deepEqual(fs.readdirSync(grace.skills), [], 'signed out: removed');
});

test('end to end: other agents get the same knowledge when detected or turned on; off and revoke remove it everywhere', async (t) => {
  const relay = await startRelay(t);
  const adaP = await relay.person('ada@keychain.com');
  const graceP = await relay.person('grace@keychain.com');
  const ada = await startDeck(t, relay, 'Ada');
  // Grace has Cursor (its folder exists) but no ~/.agents or ~/.codex.
  const grace = await startDeck(t, relay, 'Grace', {
    targets: (dir) => {
      fs.mkdirSync(path.join(dir, 'user', '.cursor'), { recursive: true });
      return [
        { id: 'agents', root: path.join(dir, 'user', '.agents', 'skills'), detect: [path.join(dir, 'user', '.agents'), path.join(dir, 'user', '.codex')] },
        { id: 'cursor', root: path.join(dir, 'user', '.cursor', 'rules'), detect: [path.join(dir, 'user', '.cursor')] },
      ];
    },
  });
  const agentsDir = path.join(grace.dir, 'user', '.agents', 'skills');
  const rulesDir = path.join(grace.dir, 'user', '.cursor', 'rules');
  fs.mkdirSync(rulesDir);
  fs.writeFileSync(path.join(rulesDir, 'graces-rule.mdc'), 'mine');
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: How Ada ships\n---\n# Deploy\nexport GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  await ada.call('POST', '/api/share/signin', { email: adaP.email, password: adaP.password });
  await grace.call('POST', '/api/share/signin', { email: graceP.email, password: graceP.password });
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['skills'], projects: ['*'] });
  await ada.agent.tick();

  let st = (await grace.call('GET', '/api/share')).data.knowledge;
  assert.deepEqual(st.targets.map((x) => [x.id, x.on, x.detected]), [['agents', false, false], ['cursor', true, true]], 'detected tools are on by default');
  const before = fingerprint(grace.dir);
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(fs.existsSync(path.join(grace.skills, 'teammate-ada-deploy', 'SKILL.md')), 'Claude Code always');
  const rule = read(rulesDir, 'teammate-ada-deploy.mdc');
  assert.match(rule, /^---\ndescription: "How Ada ships"\nalwaysApply: false\n/);
  assert.ok(!rule.includes('ghp_') && rule.includes('[token hidden]'), 'redacted on the way');
  assert.ok(!fs.existsSync(agentsDir), 'not detected, not turned on: nothing written');
  const after = fingerprint(grace.dir);
  for (const k of Object.keys(after)) if (before[k] !== after[k]) assert.match(k, /^(claude\/skills\/teammate-ada-[\w-]+\/|user\/\.cursor\/rules\/teammate-ada-[\w-]+\.mdc$|orders\/share\.json$)/, k);

  // Turned on for other agents: the next sync fetches again and writes there too.
  let r = await grace.call('POST', '/api/share/knowledge', { target: 'agents', on: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.status.knowledge.targets[0].on, true);
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.equal(parseFrontmatter(read(agentsDir, 'teammate-ada-deploy', 'SKILL.md')).name, 'teammate-ada-deploy');
  assert.ok(fs.existsSync(path.join(agentsDir, 'teammate-ada-deploy', K.MARKER)));
  assert.equal((await grace.call('POST', '/api/share/knowledge', { target: 'nope', on: true })).status, 400);

  // Turned off for Cursor: its rules go at once, the user's own rule stays, and the choice sticks.
  r = await grace.call('POST', '/api/share/knowledge', { target: 'cursor', on: false });
  assert.deepEqual(fs.readdirSync(rulesDir), ['graces-rule.mdc']);
  relay.clock.t += 10 * 60e3;
  await grace.agent.syncKnowledge();
  assert.deepEqual(fs.readdirSync(rulesDir), ['graces-rule.mdc'], 'stays off though Cursor is detected');
  await grace.call('POST', '/api/share/knowledge', { target: 'cursor', on: true });
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(fs.existsSync(path.join(rulesDir, 'teammate-ada-deploy.mdc')));

  // Revoked: removed from every agent on the next sync.
  await ada.call('POST', '/api/share/revoke', { viewer: 'grace@keychain.com' });
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.deepEqual(fs.readdirSync(grace.skills), []);
  assert.deepEqual(fs.readdirSync(agentsDir), []);
  assert.deepEqual(fs.readdirSync(rulesDir), ['graces-rule.mdc']);

  // Sign-out clears every agent too.
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['skills'], projects: ['*'] });
  relay.clock.t += 61e3;
  await ada.agent.tick();
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.ok(fs.readdirSync(agentsDir).includes('teammate-ada-deploy'));
  await grace.call('POST', '/api/share/signout', {});
  assert.deepEqual([fs.readdirSync(grace.skills), fs.readdirSync(agentsDir), fs.readdirSync(rulesDir)], [[], [], ['graces-rule.mdc']]);
});

test('teammate skills in <home>/.agents/skills (a home in the user folder) are grouped and never shared on', (t) => {
  const home = path.join(tempDir(t), 'home');
  fs.cpSync(FIX, home, { recursive: true });
  K.writeDeck(path.join(home, '.agents', 'skills'), DECK, K.planDeck(DECK, 'ada-lovelace', AT), AT);
  const entries = listLibrary(home, null, {}).filter((e) => e.key.startsWith('skill:'));
  assert.ok(entries.some((e) => e.key === 'skill:firstmate:harbor-watch'), 'own skills stay');
  assert.ok(entries.filter((e) => e.key.includes('ada-lovelace')).every((e) => e.key.startsWith('skill:teammate:') && e.group === 'Shared by Ada Lovelace'));
});

test('parseArgs: other agents default to ~/.agents/skills and ~/.cursor/rules; flags move them', () => {
  const { parseArgs } = require('../server');
  const user = os.homedir();
  const def = parseArgs(['--no-open'], { env: {}, cwd: FIX }).knowledgeTargets;
  assert.deepEqual(def.map((x) => [x.id, x.root]), [['agents', path.join(user, '.agents', 'skills')], ['cursor', path.join(user, '.cursor', 'rules')]]);
  assert.ok(def[0].detect.includes(path.join(user, '.codex')));
  const moved = parseArgs(['--agents-dir', '/tmp/x/skills', '--cursor-dir=/tmp/y/rules'], { env: {}, cwd: FIX }).knowledgeTargets;
  assert.deepEqual(moved.map((x) => [x.root, x.detect]), [['/tmp/x/skills', ['/tmp/x']], ['/tmp/y/rules', ['/tmp/y']]]);
});
