'use strict';
// Bridge features: replies CLI and thread merge, new order kinds, decision
// option parsing, Captain's Call against the real backlog format, session
// discovery and persistence, skills in the library, the markdown renderer, and
// the wake check on chat orders. Fixtures and temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const orders = require('../lib/orders');
const fleet = require('../lib/fleet');
const sessions = require('../lib/sessions');
const library = require('../lib/library');
const md = require('../public/markdown');
const cli = require('../bin/orders');
const { createServer } = require('../server');

const FIX = path.join(__dirname, 'fixtures');
const ROOT = path.join(__dirname, '..');
const mode = (p) => fs.statSync(p).mode & 0o777;

function tempDir(t, prefix = 'ship-deck-bridge-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tempHome(t) {
  const dir = tempDir(t, 'ship-deck-home-');
  fs.cpSync(path.join(FIX, 'home'), dir, { recursive: true });
  return dir;
}
function run(dir, ...argv) {
  const out = [];
  const err = [];
  const files = {};
  const code = cli.main(argv, dir, (s) => out.push(s), (s) => err.push(s), (p) => { if (!(p in files) && !fs.existsSync(p)) throw new Error('no such file: ' + p); return files[p] || fs.readFileSync(p, 'utf8'); });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// ---------- replies and the thread ----------

test('reply CLI appends to replies.jsonl (0600), validates the order, supports - and --file', (t) => {
  const dir = tempDir(t);
  const chat = orders.createOrder(dir, { kind: 'chat', text: 'What needs me?\nAlso PR 42.' });
  assert.equal(chat.text, 'What needs me?\nAlso PR 42.', 'chat keeps newlines');

  let r = run(dir, 'reply', chat.id, 'Two', 'things', 'need', 'you.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^r-\\d{8}T\\d{9}Z-[0-9a-f]{4} reply to ${chat.id}$`));
  const file = path.join(dir, orders.REPLIES_FILE);
  assert.equal(mode(file), 0o600);
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(Object.keys(line), ['id', 'ts', 'kind', 'inReplyTo', 'text']);
  assert.equal(line.kind, 'reply');
  assert.equal(line.inReplyTo, chat.id);
  assert.equal(line.text, 'Two things need you.');

  const md1 = path.join(dir, 'reply.md');
  fs.writeFileSync(md1, '# Report\n\n- PR https://github.com/example-org/harbor-app/pull/42\n- **done**\n');
  r = run(dir, 'reply', '-', '--file', md1);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /reply$/);
  const replies = orders.readReplies(dir);
  assert.equal(replies.length, 2);
  assert.equal(replies[1].inReplyTo, null, '- is an unprompted message');
  assert.equal(replies[1].text, '# Report\n\n- PR https://github.com/example-org/harbor-app/pull/42\n- **done**', 'markdown kept verbatim (trimmed)');

  r = run(dir, 'reply', chat.id, '--ack', 'done', 'Handled.');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(done\)$/);
  assert.equal(orders.listOrders(dir)[0].status, 'done', '--ack also acknowledges the order');

  assert.equal(run(dir, 'reply', 'o-20260101T000000000Z-dead', 'hi').code, 1, 'unknown order id');
  assert.equal(run(dir, 'reply', chat.id).code, 1, 'empty text');
  assert.equal(run(dir, 'reply', '-', '--ack', 'done', 'hi').code, 2, '--ack needs an order');
  assert.equal(run(dir, 'reply', chat.id, '--ack', 'maybe', 'hi').code, 2);
  assert.equal(run(dir, 'reply', chat.id, '--file', path.join(dir, 'missing.md')).code, 1);
  assert.equal(run(dir, 'reply').code, 2);
  assert.throws(() => orders.createReply(dir, null, 'x'.repeat(orders.MAX_REPLY + 1)), /larger than/);
  assert.equal(orders.readReplies(dir).length, 3, 'failed replies append nothing');
});

test('thread merges orders, acks and replies oldest first, skipping junk lines', (t) => {
  const dir = tempDir(t);
  const t0 = Date.parse('2026-01-05T10:00:00Z');
  const a = orders.createOrder(dir, { kind: 'chat', text: 'first' }, { now: t0 });
  const b = orders.createOrder(dir, { kind: 'merge', target: 'alpha-fix' }, { now: t0 + 2000 });
  const r1 = orders.createReply(dir, a.id, 'answer to first', { now: t0 + 1000 });
  const r2 = orders.createReply(dir, null, 'unprompted', { now: t0 + 3000 });
  orders.ackOrder(dir, b.id, 'acknowledged', 'checking CI', { now: t0 + 2500 });
  orders.ackOrder(dir, b.id, 'done', 'merged', { now: t0 + 2800 });
  fs.appendFileSync(path.join(dir, orders.REPLIES_FILE), 'garbage\n{"id":"r-x"}\n{"broken":\n');

  const th = orders.buildThread(dir);
  assert.deepEqual(th.map((x) => x.id), [a.id, r1.id, b.id, r2.id]);
  assert.deepEqual(th.map((x) => x.type), ['order', 'reply', 'order', 'reply']);
  const merge = th[2];
  assert.equal(merge.status, 'done');
  assert.deepEqual(merge.history.map((h) => h.status), ['acknowledged', 'done'], 'full lifecycle kept');
  assert.equal(merge.history[0].note, 'checking CI');
  assert.equal(th[1].inReplyTo, a.id);
  assert.deepEqual(orders.buildThread(dir, { limit: 2 }).map((x) => x.id), [b.id, r2.id]);
  assert.deepEqual(orders.buildThread(tempDir(t)), [], 'missing files are an empty thread');

  const sig = orders.threadSignature(dir);
  orders.createReply(dir, null, 'one more');
  assert.notEqual(orders.threadSignature(dir), sig, 'signature changes on a new reply');

  const r = run(dir, 'thread', '--limit', '3');
  assert.equal(r.code, 0);
  assert.match(r.out, /captain merge alpha-fix \[done\]/);
  assert.match(r.out, /first mate {2}r-/);
});

// ---------- order kinds ----------

test('new order kinds validate their payloads', (t) => {
  const dir = tempDir(t);
  const ctx = {
    knownIds: new Set(['alpha-fix', 'beta-scout', 'gamma-decision']),
    doneIds: new Set(['beta-scout']),
    projects: new Set(['harbor-app', 'lighthouse-api']),
    backlogIds: new Set(['tide-cache', 'drop-legacy-decision']),
  };
  const d = orders.createOrder(dir, { kind: 'decision', target: 'gamma-decision', option: 'b', text: '(B) drop it' }, ctx);
  assert.equal(d.option, 'B');
  assert.deepEqual(Object.keys(d), ['id', 'ts', 'kind', 'target', 'text', 'status', 'option']);
  assert.equal(orders.createOrder(dir, { kind: 'decision', target: 'gamma-decision', option: 'A' }, ctx).text, 'Option A', 'option alone is enough');
  assert.throws(() => orders.validateOrder({ kind: 'decision', target: 'gamma-decision' }, ctx), /pick an option or write an answer/);
  assert.throws(() => orders.validateOrder({ kind: 'decision', target: 'gamma-decision', option: 'Z' }, ctx), /letter A-H/);
  assert.throws(() => orders.validateOrder({ kind: 'decision', target: 'ghost', option: 'A' }, ctx), /unknown target/);

  const n = orders.createOrder(dir, { kind: 'new-task', project: 'harbor-app', taskKind: 'scout', text: 'Find the drift\nin tide tables' }, ctx);
  assert.equal(n.project, 'harbor-app');
  assert.equal(n.taskKind, 'scout');
  assert.equal(n.target, null);
  assert.throws(() => orders.validateOrder({ kind: 'new-task', project: 'nope', taskKind: 'ship', text: 'x' }, ctx), /unknown project/);
  assert.throws(() => orders.validateOrder({ kind: 'new-task', project: '../x', taskKind: 'ship', text: 'x' }, ctx), /invalid project/);
  assert.throws(() => orders.validateOrder({ kind: 'new-task', project: 'harbor-app', taskKind: 'rm', text: 'x' }, ctx), /taskKind/);
  assert.throws(() => orders.validateOrder({ kind: 'new-task', project: 'harbor-app', taskKind: 'ship' }, ctx), /text is required/);

  const c = orders.createOrder(dir, { kind: 'cleanup-done', targets: ['beta-scout', 'beta-scout'] }, ctx);
  assert.deepEqual(c.targets, ['beta-scout'], 'deduplicated');
  assert.equal(c.text, 'Clean up all finished crew');
  assert.throws(() => orders.validateOrder({ kind: 'cleanup-done', targets: ['alpha-fix'] }, ctx), /alpha-fix is not done/);
  assert.throws(() => orders.validateOrder({ kind: 'cleanup-done', targets: [] }, ctx), /no finished crew/);
  assert.throws(() => orders.validateOrder({ kind: 'cleanup-done', targets: ['../x'] }, ctx), /invalid target/);
  assert.throws(() => orders.validateOrder({ kind: 'cleanup-done', targets: 'beta-scout' }, ctx), /no finished crew/);

  assert.equal(orders.createOrder(dir, { kind: 'backlog-start', item: 'tide-cache' }, ctx).item, 'tide-cache');
  const ba = orders.createOrder(dir, { kind: 'backlog-answer', item: 'drop-legacy-decision', option: 'A', text: 'keep it' }, ctx);
  assert.equal(ba.option, 'A');
  assert.throws(() => orders.validateOrder({ kind: 'backlog-start', item: 'nope' }, ctx), /unknown backlog item/);
  assert.throws(() => orders.validateOrder({ kind: 'backlog-start', item: '../../etc' }, ctx), /invalid backlog item/);
  assert.throws(() => orders.validateOrder({ kind: 'backlog-answer', item: 'tide-cache' }, ctx), /pick an option/);

  assert.throws(() => orders.validateOrder({ kind: 'chat', text: '   ' }), /text is required/);
  assert.throws(() => orders.validateOrder({ kind: 'chat', text: 'x'.repeat(orders.MAX_CHAT + 1) }), /longer than/);
  assert.throws(() => orders.validateOrder({ kind: '__proto__' }), /unknown order kind/);
  assert.equal(orders.validateOrder({ kind: 'chat', text: 'a\u0000b\u0007c\r\nd' }).text, 'abc\nd', 'control characters dropped, newlines kept');

  const r = run(dir, 'list');
  assert.match(r.out, /option=B/);
  assert.match(r.out, /project=harbor-app taskKind=scout/);
  assert.match(r.out, /targets=beta-scout/);
  assert.match(r.out, /item=tide-cache/);
  assert.match(r.out, / {4}Find the drift\n {4}in tide tables/, 'multi-line text is indented');
});

test('orders-check.sh wakes the first mate for chat and every other new order kind', (t) => {
  const home = tempDir(t, 'ship-deck-home-');
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  const check = () => execFileSync('/bin/sh', [path.join(ROOT, 'bin/orders-check.sh')], { env, encoding: 'utf8' });
  const dir = path.join(home, '.ship-deck');
  orders.createOrder(dir, { kind: 'chat', text: 'are you there?\n"id":"o-99999999T999999999Z-ffff"' });
  assert.equal(check(), 'ship-deck: 1 new captain order(s)\n');
  assert.equal(check(), '');
  orders.createReply(dir, null, 'yes');
  assert.equal(check(), '', 'replies never wake the first mate');
  orders.createOrder(dir, { kind: 'chat', text: 'second' });
  orders.createOrder(dir, { kind: 'new-task', project: 'harbor-app', taskKind: 'ship', text: 'x' });
  orders.createOrder(dir, { kind: 'cleanup-done', targets: ['beta-scout'] });
  orders.createOrder(dir, { kind: 'decision', target: 'gamma-decision', option: 'A' });
  assert.equal(check(), 'ship-deck: 4 new captain order(s)\n');
});

// ---------- decision options ----------

test('parseOptions reads lettered choices in the shapes the fleet writes', () => {
  const p = (s) => fleet.parseOptions(s).map((o) => [o.letter, o.text, o.recommended]);
  assert.deepEqual(p('Next refuses a second server. Options: (A) I create a throwaway worktree - non-destructive; (B) you authorise killing pid 42 - destructive; (C) compare on a different port. I checked /7 briefly.'), [
    ['A', 'I create a throwaway worktree - non-destructive', false],
    ['B', 'you authorise killing pid 42 - destructive', false],
    ['C', 'compare on a different port', false],
  ]);
  assert.deepEqual(p('drops an event. Options: (A, recommended) --action fix: extend the primitive. (B) --action skip: accept it'), [
    ['A', '--action fix: extend the primitive', true],
    ['B', '--action skip: accept it', false],
  ]);
  assert.deepEqual(p('OPTIONS: A) keep it B) drop it'), [['A', 'keep it', false], ['B', 'drop it', false]]);
  assert.deepEqual(p('Captain must choose option A, fix the build first then redeploy, or option B, redeploy immediately from 7a28c32 which is pre-break.'), [
    ['A', 'fix the build first then redeploy', false],
    ['B', 'redeploy immediately from 7a28c32 which is pre-break', false],
  ]);
  assert.deepEqual(p('(A) only one option'), [], 'needs at least A and B');
  assert.deepEqual(p('see (B) then (A)'), [], 'letters must run in order');
  assert.deepEqual(p('a plan) and b) without the word'), [], 'bare letters need an "options" cue');
  assert.deepEqual(p(''), []);
  assert.deepEqual(p(undefined), []);
});

test('snapshot carries decision options for needs-decision crew', async (t) => {
  const home = tempHome(t);
  const s = await fleet.buildSnapshot(home, { tmux: false });
  const g = s.tasks.find((x) => x.id === 'gamma-decision');
  assert.deepEqual(g.options.map((o) => [o.letter, o.text, o.recommended]), [
    ['A', 'keep it behind a flag', false],
    ['B', 'drop it and redirect to v2', true],
  ]);
  assert.deepEqual(s.tasks.find((x) => x.id === 'alpha-fix').options, [], 'working crew have no options');
});

// ---------- Captain's Call ----------

test("Captain's Call counts calls in the real backlog format (no Captain's Call section)", () => {
  const b = fleet.parseBacklog(fs.readFileSync(path.join(FIX, 'backlog', 'real-format.md'), 'utf8'));
  assert.equal(b.captain.length, 0, 'the real file has no "## Captain\'s Call" section');
  const calls = fleet.captainCalls(b);
  assert.deepEqual(calls.map((c) => c.id), [
    'buoy-refit-decision-paint-scope', 'tide-scout-decision-redeploy-ordering', 'quarterly-review', 'lantern-scope',
  ], 'kind: captain and hold-kind: captain items in Queued; resolved calls in Done do not count');
  assert.ok(calls.every((c) => c.section === 'queued' && b.queued[c.index] && b.queued[c.index].id === c.id));
  assert.equal(b.queued.length, 7, 'indented notes with "#" and "-" lines stay notes');
  assert.ok(b.queued.find((x) => x.id === 'beacon-flag-techdebt').notes.length > 0);
  assert.deepEqual(calls.find((c) => c.id === 'tide-scout-decision-redeploy-ordering').options.map((o) => o.letter), ['A', 'B']);
  assert.deepEqual(calls.find((c) => c.id === 'lantern-scope').options.map((o) => o.text), [
    'cost lines only, meaning no backend work', 'untyped costs in line metadata', 'first-class per-lamp child rows',
  ]);
  assert.match(calls[0].tags.hold, /fleet-wide/, 'hold text with nested parentheses survives');
});

test("snapshot exposes the Captain's Call count across sections", async (t) => {
  const home = tempHome(t);
  let s = await fleet.buildSnapshot(home, { tmux: false });
  assert.deepEqual(s.backlog.calls.map((c) => c.id), ['pick-beacon-color', 'drop-legacy-decision'], 'the section format still works');
  fs.copyFileSync(path.join(FIX, 'backlog', 'real-format.md'), path.join(home, 'data', 'backlog.md'));
  s = await fleet.buildSnapshot(home, { tmux: false });
  assert.equal(s.backlog.captain.length, 0);
  assert.equal(s.backlog.callCount, 4, 'was 0 before: only the missing section was counted');
});

// ---------- sessions ----------

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function writeTranscript(claudeDir, cwd, sessionId, { started, mtime, brief = '', cwdInFile = cwd, idInFile = sessionId }) {
  const dir = path.join(claudeDir, 'projects', cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  const lines = [
    { type: 'mode', mode: 'normal', sessionId: idInFile },
    'not json at all',
    { type: 'user', cwd: cwdInFile, sessionId: idInFile, timestamp: new Date(started).toISOString(), message: { content: brief } },
  ];
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test('encodeCwd matches Claude project dir names', () => {
  assert.ok(sessions.encodeCwd('/Users/aryanbhandari/.treehouse/ship-deck-aeac92/1/ship-deck').includes('-Users-aryanbhandari--treehouse-ship-deck-aeac92-1-ship-deck'));
  assert.ok(sessions.encodeCwd('/tmp/a_b/c/').includes('-tmp-a-b-c'), 'other separators and a trailing slash');
});

test('session discovery: newest verified transcript per crew, shared worktrees split by brief and spawn time', (t) => {
  const home = tempHome(t);
  const claudeDir = tempDir(t, 'ship-deck-claude-');
  const now = Date.now();
  const H = 3600000;
  const wt = '/fake/worktrees/harbor-1';
  // alpha-fix and gamma-decision both used harbor-1; alpha spawned 10 h ago, gamma 2 h ago.
  for (const [id, ago] of [['alpha-fix', 10], ['gamma-decision', 2]]) {
    fs.writeFileSync(path.join(home, 'state', id + '.meta'), fs.readFileSync(path.join(home, 'state', id + '.meta'), 'utf8').replace(/^worktree=.*$/m, '') + `worktree=${wt}\nharness=claude\n`);
  }
  const tasks = [
    { id: 'alpha-fix', harness: 'claude', worktree: wt },
    { id: 'gamma-decision', harness: 'claude', worktree: wt },
    { id: 'beta-scout', harness: 'codex', worktree: '/fake/worktrees/harbor-2' },
    { id: 'delta-block', harness: 'claude', worktree: '/fake/worktrees/nothing-here' },
  ];
  const spawn = { 'alpha-fix': now - 10 * H, 'gamma-decision': now - 2 * H };
  // Pretend the metas were born at the spawn times (birth time cannot be set, so stub it via mtime on a copy).
  const old = writeTranscript(claudeDir, wt, UUID(1), { started: now - 30 * H, mtime: now - 20 * H, brief: 'state/old-task.status' });
  const alpha = writeTranscript(claudeDir, wt, UUID(2), { started: now - 9 * H, mtime: now - 1 * H });
  const gamma = writeTranscript(claudeDir, wt, UUID(3), { started: now - 1.5 * H, mtime: now - 0.5 * H, brief: `append to '${home}/state/gamma-decision.status'` });
  writeTranscript(claudeDir, wt, UUID(4), { started: now - 1 * H, mtime: now, cwdInFile: '/somewhere/else' });
  writeTranscript(claudeDir, wt, UUID(5), { started: now - 1 * H, mtime: now, idInFile: UUID(9) });
  fs.mkdirSync(path.join(path.dirname(alpha), UUID(2), 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(alpha), 'notes.jsonl'), '{}\n');

  const found = sessions.assignSessions(claudeDir, wt, tasks.slice(0, 2).map((x) => ({ id: x.id, spawn: spawn[x.id] })));
  assert.equal(found['gamma-decision'].sessionId, UUID(3), 'brief names the crew member');
  assert.equal(found['gamma-decision'].matched, 'brief');
  assert.equal(found['alpha-fix'].sessionId, UUID(2), 'newest session started after its spawn and before the next spawn');
  assert.equal(found['alpha-fix'].matched, 'spawn-time');
  assert.ok(!Object.values(found).some((f) => [UUID(1), UUID(4), UUID(5)].includes(f.sessionId)), 'other-task, wrong-cwd and mismatched-id transcripts are never picked');
  assert.equal(old.endsWith(UUID(1) + '.jsonl'), true);

  assert.equal(sessions.findCrewSession(claudeDir, { id: 'gamma-decision', cwd: wt, since: now - 2 * H }).sessionId, UUID(3));
  assert.equal(sessions.findCrewSession(claudeDir, { id: 'nobody', cwd: '/fake/none', since: now }), null);

  writeTranscript(claudeDir, home, UUID(7), { started: now - 5 * H, mtime: now - 4 * H });
  writeTranscript(claudeDir, home, UUID(8), { started: now - 3 * H, mtime: now - 60000 });
  const all = sessions.discoverSessions({ home, tasks, claudeDir });
  assert.equal(all[sessions.FIRST_MATE_KEY].sessionId, UUID(8), 'first mate: newest session in FM_HOME');
  assert.equal(all['beta-scout'], undefined, 'other harnesses are skipped');
  assert.equal(all['delta-block'], undefined, 'no transcripts, no session');
  assert.ok(gamma);
});

test('sessions.json: 0600, merges, keeps departed crew, rewrites only on change', (t) => {
  const dir = path.join(tempDir(t), '.ship-deck');
  const t0 = Date.parse('2026-01-05T10:00:00Z');
  let map = sessions.recordSessions(dir, { 'alpha-fix': { sessionId: UUID(1), cwd: '/w/1', harness: 'claude' } }, t0);
  const file = path.join(dir, sessions.SESSIONS_FILE);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(map['alpha-fix'], { sessionId: UUID(1), cwd: '/w/1', harness: 'claude', firstSeen: t0, lastSeen: t0 });

  const before = fs.statSync(file).mtimeMs;
  sessions.recordSessions(dir, { 'alpha-fix': { sessionId: UUID(1), cwd: '/w/1' } }, t0 + 60000);
  assert.equal(fs.statSync(file).mtimeMs, before, 'no write for an unchanged session seen a minute later');

  map = sessions.recordSessions(dir, { [sessions.FIRST_MATE_KEY]: { sessionId: UUID(2), cwd: '/home' } }, t0 + 120000);
  assert.ok(map['alpha-fix'], 'alpha-fix survives after it disappears from discovery');
  map = sessions.recordSessions(dir, { 'alpha-fix': { sessionId: UUID(3), cwd: '/w/1' } }, t0 + 20 * 60000);
  assert.equal(map['alpha-fix'].sessionId, UUID(3));
  assert.equal(map['alpha-fix'].previous[0].sessionId, UUID(1), 'a replaced session is kept as history');
  map = sessions.recordSessions(dir, {}, t0 + 40 * 60000);
  assert.equal(map['alpha-fix'].lastSeen, t0 + 20 * 60000);

  fs.writeFileSync(file, '{not json');
  assert.deepEqual(sessions.loadSessions(dir), {}, 'a corrupt file reads as empty');

  sessions.saveSessions(dir, { 'alpha-fix': { sessionId: UUID(1), cwd: "/w/it's here", harness: 'claude', lastSeen: t0 } });
  const r = run(dir, 'sessions');
  assert.equal(r.code, 0);
  assert.match(r.out, /alpha-fix {2}claude/);
  assert.ok(r.out.includes(`cd '/w/it'\\''s here' && claude --resume ${UUID(1)}`), 'single quotes are shell-escaped');
  assert.deepEqual(Object.keys(JSON.parse(run(dir, 'sessions', '--json').out)), ['alpha-fix']);
  assert.match(run(tempDir(t), 'sessions').out, /no sessions recorded/);
  assert.equal(sessions.resumeCommand('/w', 'not-a-uuid; rm -rf /'), null, 'only real session ids become commands');
});

// ---------- skills ----------

test('library lists skills from both roots with frontmatter, by key only', (t) => {
  const home = tempHome(t);
  const captainSkills = path.join(FIX, 'skills');
  const entries = library.listLibrary(home, null, { captainSkills });
  const skills = entries.filter((e) => e.key.startsWith('skill:'));
  assert.deepEqual(skills.map((e) => [e.key, e.group, e.label]), [
    ['skill:captain:tide-tables', "Captain's skills", 'tide-tables'],
    ['skill:firstmate:harbor-watch', 'Firstmate skills', 'harbor-watch'],
  ], 'dot dirs and dirs without SKILL.md are skipped');
  assert.equal(skills[0].description, "Captain's sample skill: reading the tide tables, with <b>no HTML</b> allowed.");
  assert.equal(skills[1].description, 'Sample firstmate skill: how the watch rotates at the harbor. Use when a beacon goes dark.', 'folded scalar');

  const r = library.readLibraryEntry(home, null, 'skill:firstmate:harbor-watch', { captainSkills });
  assert.match(r.text, /# Harbor watch/);
  for (const bad of ['skill:firstmate:../../state', 'skill:captain:.trash', 'skill:firstmate:no-skill-here', 'skill:captain:tide-tables/../x']) {
    assert.equal(library.readLibraryEntry(home, null, bad, { captainSkills }), null, bad);
  }
  assert.equal(library.listLibrary(home, null).filter((e) => e.group === "Captain's skills").length, 0, 'no captain skills without the option');
  assert.deepEqual(library.parseFrontmatter('no frontmatter'), {});
  assert.deepEqual(library.parseFrontmatter('---\nname: x\ndescription: |\n  line one\n  line two\n---\nbody'), { name: 'x', description: 'line one\nline two' });
});

// ---------- markdown ----------

test('markdown renderer escapes HTML and only links http(s)', () => {
  const html = md.render('<script>alert(1)</script> **bold** `a<b>` [x](javascript:alert(1)) [ok](https://e.com/?a=1&b=2)\n\nSee https://github.com/example-org/harbor-app/pull/42.', { breaks: true });
  assert.ok(!/<script/i.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>a&lt;b&gt;<\/code>/);
  assert.ok(!/href="javascript/i.test(html));
  assert.match(html, /<a href="https:\/\/e.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /<a href="https:\/\/github.com\/example-org\/harbor-app\/pull\/42" target="_blank" rel="noopener noreferrer">[^<]+<\/a>\./, 'full PR URLs autolink; trailing dot stays outside');
  assert.ok(!md.render('"><img src=x onerror=alert(1)> https://e.com/"onmouseover="x').includes('<img'));
  assert.ok(!/href="[^"]*"[^>]*onmouseover/.test(md.render('https://e.com/"onmouseover="x')));

  const list = md.render('1. one\n   - nested\n2. two\n\n| a | b |\n|---|---|\n| <i>1</i> | 2 |');
  assert.match(list, /<ol>\n<li>one\n<ul>\n<li>nested\n<\/li><\/ul>\n<\/li>\n<li>two\n<\/li><\/ol>/);
  assert.match(list, /<td>&lt;i&gt;1&lt;\/i&gt;<\/td>/);
  assert.match(md.render('---\nname: x\n---\n# T'), /<dl class="md-front"><dt>name<\/dt><dd>x<\/dd><\/dl>\n<h2>T<\/h2>/);
  assert.equal(md.render('---\nname: x\n---\nbody', { frontmatter: 'hide' }), '<p>body</p>');
});

// ---------- HTTP ----------

async function startServer(t) {
  const home = tempHome(t);
  const ordersDir = tempDir(t, 'ship-deck-orders-');
  const claudeDir = tempDir(t, 'ship-deck-claude-');
  fs.mkdirSync(path.join(claudeDir, 'skills'));
  fs.cpSync(path.join(FIX, 'skills', 'tide-tables'), path.join(claudeDir, 'skills', 'tide-tables'), { recursive: true });
  const now = Date.now();
  writeTranscript(claudeDir, home, UUID(11), { started: now - 1000, mtime: now });
  const server = createServer({ home, tmux: false, staleDays: 7, ordersDir, memoryDir: null, claudeDir, exec: async () => ({ code: 0, stdout: '', stderr: '' }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: JSON.stringify(body) });
  const get = async (p) => (await fetch(base + p)).json();
  return { home, ordersDir, claudeDir, base, post, get };
}

test('HTTP: chat, thread, sessions, skills and validated order kinds', async (t) => {
  const { home, ordersDir, post, get } = await startServer(t);
  let r = await post({ kind: 'chat', text: 'hello\nfirst mate' });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  orders.createReply(ordersDir, order.id, '**ahoy**');

  let s = await get('/api/fleet');
  assert.equal(s.thread.replies, 1);
  assert.match(s.thread.lastReplyId, /^r-/);
  assert.equal(s.firstmate.session.sessionId, UUID(11));
  assert.equal(s.firstmate.session.resume, `cd '${home}' && claude --resume ${UUID(11)}`);
  assert.equal(s.tasks.find((x) => x.id === 'beta-scout').session.note, 'resume id unknown (codex)');
  assert.match(s.tasks.find((x) => x.id === 'alpha-fix').session.note, /no Claude session found/);
  assert.equal(s.backlog.callCount, 2);

  const th = await get('/api/thread');
  assert.deepEqual(th.items.map((x) => x.type), ['order', 'reply']);
  assert.equal(th.items[0].text, 'hello\nfirst mate');
  assert.equal(th.sig, s.thread.sig);

  const ss = await get('/api/sessions');
  assert.equal(ss.entries[0].firstmate, true);
  assert.equal(mode(path.join(ordersDir, 'sessions.json')), 0o600);

  // Every kind validates against the live home: crew, done crew, projects and backlog ids.
  assert.equal((await post({ kind: 'decision', target: 'gamma-decision', option: 'B', text: '(B) drop it' })).status, 200);
  assert.equal((await post({ kind: 'new-task', project: 'harbor-app', taskKind: 'ship', text: 'add a lamp' })).status, 200);
  assert.equal((await post({ kind: 'new-task', project: 'atlantis', taskKind: 'ship', text: 'x' })).status, 400);
  assert.equal((await post({ kind: 'cleanup-done', targets: ['beta-scout'] })).status, 200);
  assert.equal((await post({ kind: 'cleanup-done', targets: ['alpha-fix'] })).status, 400, 'alpha-fix is still working');
  assert.equal((await post({ kind: 'backlog-start', item: 'tide-cache' })).status, 200);
  assert.equal((await post({ kind: 'backlog-answer', item: 'drop-legacy-decision', text: 'drop it' })).status, 200);
  assert.equal((await post({ kind: 'backlog-start', item: 'beta-scout' })).status, 400, 'done items are not startable');
  s = await get('/api/fleet');
  assert.equal(s.orders.pending, 6);
  assert.deepEqual(s.orders.list.map((o) => o.kind), ['backlog-answer', 'backlog-start', 'cleanup-done', 'new-task', 'decision', 'chat']);

  const lib = await get('/api/library');
  assert.deepEqual(lib.entries.filter((e) => e.key.startsWith('skill:')).map((e) => e.key), ['skill:captain:tide-tables', 'skill:firstmate:harbor-watch']);
  const sk = await get('/api/library/file?key=' + encodeURIComponent('skill:captain:tide-tables'));
  assert.match(sk.text, /\| High \| 4.2 m \|/);
});

test('start.sh starts nothing when the port is already served', (t) => {
  const http = require('node:http');
  const srv = http.createServer((q, s) => s.end('busy'));
  return new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', () => {
    t.after(() => srv.close());
    const home = tempDir(t, 'ship-deck-home-');
    try {
      const out = execFileSync('/bin/sh', [path.join(ROOT, 'bin/start.sh'), '--port', String(srv.address().port)], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
      assert.match(out, /already running/);
      assert.equal(fs.existsSync(path.join(home, '.ship-deck', 'server.log')), false, 'no server spawned');
      resolve();
    } catch (e) { reject(e); }
  }));
});
