'use strict';
// Usage counts: a teammate's deck counts how often its Claude Code used what a captain shared
// (from transcripts, read only) and reports counts only; the relay keeps them for the captain,
// checked against the grant and the captain's library, with one audit row per report.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../lib/usage');
const RU = require('../relay/lib/usage');
const { createServer, listen } = require('../server');
const { startRelay } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const TS = '2026-10-14T11:30:00.000Z';
const skillUse = (id, skill, ts = TS) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] } });
const readUse = (id, file, ts = TS) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
const command = (uuid, name, ts = TS) => JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: `<command-message>x</command-message>\n<command-name>/${name}</command-name>` } });
const prompt = (uuid, text) => JSON.stringify({ type: 'user', uuid, timestamp: TS, message: { role: 'user', content: text } });

test('usesInLine: the Skill tool, a Read of SKILL.md and the slash command count; a mention does not', () => {
  assert.deepEqual(U.usesInLine(skillUse('tu_1', 'teammate-ada-deploy')), [{ name: 'teammate-ada-deploy', id: 'tu_1', ts: Date.parse(TS) }]);
  assert.equal(U.usesInLine(readUse('tu_2', '/Users/g/.claude/skills/teammate-ada-notes/SKILL.md'))[0].name, 'teammate-ada-notes');
  assert.equal(U.usesInLine(command('u1', 'teammate-ada-deploy'))[0].name, 'teammate-ada-deploy');
  assert.deepEqual(U.usesInLine(prompt('u2', 'what does teammate-ada-deploy do?')), [], 'a prompt that names it is not a use');
  assert.deepEqual(U.usesInLine(skillUse('tu_3', 'deploy')), [], 'own skills are not counted');
  assert.deepEqual(U.usesInLine(readUse('tu_4', '/x/teammate-ada-deploy/README.md')), []);
  assert.deepEqual(U.usesInLine('{not json teammate-'), []);
});

test('scan: reads only what was appended, waits for a whole line, de-dupes copied lines, skips old files', (t) => {
  const projects = path.join(tempDir(t), 'projects');
  fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
  fs.mkdirSync(path.join(projects, 'p2'));
  const a = path.join(projects, 'p1', 'a.jsonl');
  fs.writeFileSync(a, skillUse('tu_1', 'teammate-ada-deploy') + '\n' + prompt('u', 'hello') + '\n' + skillUse('tu_2', 'teammate-ada-deploy').slice(0, 30));
  const st = U.readState(path.join(projects, 'none.json'));
  assert.deepEqual(U.scan(projects, st).map((u) => u.id), ['tu_1']);
  assert.ok(st.files['p1/a.jsonl'] < fs.statSync(a).size, 'the partial line is left for later');
  fs.writeFileSync(a, skillUse('tu_1', 'teammate-ada-deploy') + '\n' + prompt('u', 'hello') + '\n' + skillUse('tu_2', 'teammate-ada-deploy') + '\n');
  assert.deepEqual(U.scan(projects, st).map((u) => u.id), ['tu_2']);
  assert.deepEqual(U.scan(projects, st), [], 'nothing new');
  // A resumed session copies earlier lines into a new file: counted once.
  fs.writeFileSync(path.join(projects, 'p2', 'b.jsonl'), skillUse('tu_2', 'teammate-ada-deploy') + '\n' + command('u3', 'teammate-ada-notes') + '\n');
  assert.deepEqual(U.scan(projects, st).map((u) => u.id), ['u3:teammate-ada-notes']);
  // A file untouched since the entries were written is not read at all.
  const old = path.join(projects, 'p2', 'old.jsonl');
  fs.writeFileSync(old, skillUse('tu_9', 'teammate-ada-deploy') + '\n');
  fs.utimesSync(old, new Date('2026-01-01'), new Date('2026-01-01'));
  assert.deepEqual(U.scan(projects, st, { since: Date.parse('2026-06-01') }), []);
  assert.equal(st.files['p2/old.jsonl'], 0);
});

test('relay: a report is counts only, de-duped, capped and clamped', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const items = RU.sanitizeReport({ v: 1, items: [
    { captainSub: 'adaSub000001', key: 'skill:captain:deploy', count: 2, last: now - 1000, text: 'never kept' },
    { captainSub: 'adaSub000001', key: 'skill:captain:deploy', count: 3, last: now + 9e9 },
    { captainSub: 'adaSub000001', key: 'notes', count: 1e9 },
    { captainSub: 'bad', key: 'skill:captain:x', count: 1 },
    { captainSub: 'adaSub000001', key: '../etc', count: 1 },
    { captainSub: 'adaSub000001', key: 'skill:captain:zero', count: 0 },
  ] }, now);
  assert.deepEqual(items, [
    { captainSub: 'adaSub000001', key: 'skill:captain:deploy', count: 5, last: now },
    { captainSub: 'adaSub000001', key: 'notes', count: RU.MAX_COUNT, last: now },
  ]);
  assert.throws(() => RU.sanitizeReport({ items: [] }, now));
  const raw = ['c\tskill:captain:deploy\tg@keychain.com', '5', 'l\tskill:captain:deploy\tg@keychain.com', String(now), 'c\tnotes\tg@keychain.com', '1', 'l\tnotes\tg@keychain.com', String(now - 100 * 86400e3)];
  assert.deepEqual(RU.readRows(raw, now), [{ key: 'skill:captain:deploy', viewerEmail: 'g@keychain.com', count: 5, last: now }], 'older than 90 days is dropped');
});

async function startDeck(t, relay, name) {
  const dir = tempDir(t);
  fs.cpSync(FIX, path.join(dir, 'home'), { recursive: true });
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(path.join(claudeDir, 'projects', 'p'), { recursive: true });
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
  return { call, dir, claudeDir, skills: path.join(claudeDir, 'skills'), transcript: path.join(claudeDir, 'projects', 'p', 's.jsonl'), agent: server.shareAgent };
}

test('end to end: the receiver reports counts, the captain sees them per skill and in the log; refusals and opt-out', async (t) => {
  const relay = await startRelay(t);
  const people = await Promise.all(['ada', 'grace', 'sam'].map((n) => relay.person(n + '@keychain.com')));
  const [ada, grace, sam] = await Promise.all(['Ada', 'Grace', 'Sam'].map((n) => startDeck(t, relay, n)));
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: How Ada ships\n---\n# Deploy\n');
  fs.mkdirSync(path.join(ada.dir, 'home', 'data'), { recursive: true });
  fs.writeFileSync(path.join(ada.dir, 'home', 'data', 'captain.md'), 'Keep PRs small.\n');
  for (const [deck, p] of [[ada, people[0]], [grace, people[1]], [sam, people[2]]]) await deck.call('POST', '/api/share/signin', { email: p.email, password: p.password });
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'skills', 'notes'], projects: ['*'] });
  await ada.agent.tick();
  assert.equal(await grace.agent.syncKnowledge(), 'synced');

  // Grace's agent uses Ada's deploy skill twice (once by the Skill tool, once by /command) and her notes once.
  const secret = 'my private prompt about the merger';
  fs.writeFileSync(grace.transcript, [
    prompt('u0', secret), skillUse('tu_1', 'teammate-ada-deploy'), command('u1', 'teammate-ada-deploy'),
    readUse('tu_2', path.join(grace.skills, 'teammate-ada-notes', 'SKILL.md')), skillUse('tu_3', 'my-own-skill'),
  ].join('\n') + '\n');
  let n = relay.store.stats.commands;
  assert.equal(await grace.agent.reportUsage(), 'reported');
  assert.equal(relay.store.stats.commands - n, 10, 'free-tier budget: auth 1, grant and library 2, counts 5, audit 2');
  assert.equal(await grace.agent.reportUsage(), 'wait', 'scanned at most every 15 minutes');

  const rows = (await ada.call('GET', '/api/share/usage')).data.rows;
  assert.deepEqual(rows.map((r) => [r.title || r.key, r.viewerEmail, r.count]), [['deploy', 'grace@keychain.com', 2], ['notes', 'grace@keychain.com', 1]]);
  assert.equal(rows[0].last, Date.parse(TS));
  const log = (await ada.call('GET', '/api/share/audit')).data.rows.find((r) => r.result === 'used');
  assert.equal(log.who, 'grace@keychain.com');
  assert.equal(log.what, 'Their agent used "deploy" 2 times, your notes once');
  // Counts only: nothing of the transcript reached the relay.
  const [, keys] = await relay.store.cmd(['SCAN', '0', 'MATCH', 'use:*']);
  const fields = await relay.store.cmd(['HGETALL', keys[0]]);
  assert.ok(fields.every((f) => !String(f).includes('merger') && !String(f).includes(grace.dir)), 'only keys, emails, counts and times');

  // More uses later add up; the report waits for the hour.
  fs.appendFileSync(grace.transcript, skillUse('tu_4', 'teammate-ada-deploy') + '\n');
  relay.clock.t += 15 * 60e3;
  assert.equal(await grace.agent.reportUsage(), 'scanned', 'counted, reported within the hour');
  relay.clock.t += 45 * 60e3;
  assert.equal(await grace.agent.reportUsage(), 'reported');
  assert.equal((await ada.call('GET', '/api/share/usage')).data.rows[0].count, 3);

  // A deck without a grant cannot add counts, nor can a granted one for a key Ada does not share.
  const samToken = JSON.parse(fs.readFileSync(path.join(sam.dir, 'orders', 'share.json'), 'utf8')).token;
  const adaSub = (await relay.store.cmd(['SCAN', '0', 'MATCH', 'lib:*']))[1][0].slice(4);
  let r = await relay.deckCall(samToken, 'POST', '/v1/usage', { v: 1, items: [{ captainSub: adaSub, key: 'skill:captain:deploy', count: 99 }] });
  assert.deepEqual([r.status, r.data.accepted], [200, 0]);
  const graceToken = JSON.parse(fs.readFileSync(path.join(grace.dir, 'orders', 'share.json'), 'utf8')).token;
  r = await relay.deckCall(graceToken, 'POST', '/v1/usage', { v: 1, items: [{ captainSub: adaSub, key: 'skill:captain:invented', count: 99 }] });
  assert.equal(r.data.accepted, 0);
  assert.equal((await relay.deckCall(graceToken, 'POST', '/v1/usage', { items: 'x' })).status, 400);
  assert.equal((await relay.deckCall(null, 'POST', '/v1/usage', { v: 1, items: [] })).status, 401);
  assert.equal((await ada.call('GET', '/api/share/usage')).data.rows[0].count, 3);

  // Opt-out: nothing is scanned or sent, and pending counts are dropped.
  fs.appendFileSync(grace.transcript, skillUse('tu_5', 'teammate-ada-deploy') + '\n');
  relay.clock.t += 15 * 60e3;
  assert.equal(await grace.agent.reportUsage(), 'scanned');
  r = await grace.call('POST', '/api/share/knowledge', { reportUsage: false });
  assert.equal(r.data.status.knowledge.usage.on, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(grace.dir, 'orders', 'usage.json'), 'utf8')).pending, {});
  relay.clock.t += 60 * 60e3;
  assert.equal(await grace.agent.reportUsage(), 'off');
  assert.equal((await ada.call('GET', '/api/share/usage')).data.rows[0].count, 3);
});
