'use strict';
// Status flags and the Board: every worker state maps to one tone, one International Code of
// Signals flag and one word (public/board.js), shared by the page and these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const board = require('../public/board');

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 13, 12, 0);

test('each state flies its signal flag', () => {
  const flag = (state, stale) => board.flagOf(state, stale);
  assert.equal(flag('needs-decision'), 'k', 'K: I wish to communicate with you');
  assert.equal(flag('blocked'), 'v', 'V: I require assistance');
  assert.equal(flag('working'), 'p', 'P, the Blue Peter: under way');
  assert.equal(flag('resolved'), 'p', 'a resolved blocker reads as working');
  assert.equal(flag('paused'), 'x', 'X: watch for my signals');
  assert.equal(flag('unknown'), 'x', 'no status yet is waiting');
  assert.equal(flag(undefined), 'x');
  assert.equal(flag('done'), 'c', 'C: affirmative');
  assert.equal(flag('failed'), 'o', 'O: man overboard');
  assert.equal(flag('needs-decision', true), 'q0', 'a quiet worker strikes its flag, whatever the state');
  assert.equal(flag('mystery-state'), 'x', 'unknown states fall back to waiting');
});

test('every tone has a flag, a sentence-case word and its meaning at sea', () => {
  const flags = new Set();
  for (const tone of board.TONE_ORDER) {
    const t = board.TONES[tone];
    assert.ok(t, tone);
    assert.match(t.word, /^[A-Z][a-z]/, `${tone} word is sentence case`);
    assert.notEqual(t.word, t.word.toUpperCase());
    assert.match(t.meaning, /^[A-Z]/);
    flags.add(t.flag);
  }
  assert.equal(flags.size, board.TONE_ORDER.length, 'no two tones share a flag');
});

test('statusOf gives the pill: tone, flag and label', () => {
  const s = (t) => board.statusOf(t, NOW);
  assert.deepEqual(s({ state: 'needs-decision' }), { tone: 'needs', flag: 'k', label: 'Your call' });
  assert.deepEqual(s({ state: 'blocked' }), { tone: 'blocked', flag: 'v', label: 'Blocked' });
  assert.deepEqual(s({ state: 'working' }), { tone: 'working', flag: 'p', label: 'Working' });
  assert.deepEqual(s({ state: 'paused' }), { tone: 'waiting', flag: 'x', label: 'Paused' });
  assert.deepEqual(s({ state: 'unknown' }), { tone: 'waiting', flag: 'x', label: 'No update yet' });
  assert.deepEqual(s({ state: 'failed' }), { tone: 'failed', flag: 'o', label: 'Failed' });
  assert.deepEqual(s({ state: 'done', kind: 'ship' }), { tone: 'done', flag: 'c', label: 'Done' });
  assert.equal(s({ state: 'done', kind: 'scout', hasReport: true }).label, 'Report ready');
  assert.deepEqual(s({ state: 'working', stale: true, lastActivity: NOW - 9 * DAY }), { tone: 'quiet', flag: 'q0', label: 'Quiet for 9 days' });
  assert.equal(s({ state: 'working', stale: true, lastActivity: NOW - 1.2 * DAY }).label, 'Quiet for 1 day');
  assert.deepEqual(board.callStatus(), { tone: 'needs', flag: 'k', label: 'Queued question' });
});

// ---------- grouping ----------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSnapshot } = require('../lib/fleet');
const FIXTURE = path.join(__dirname, 'fixtures', 'home');

async function fixtureSnapshot(opts = {}) {
  // The fixture's mtimes are wherever git left them; pin "now" to just after them so nothing is quiet.
  const newest = Math.max(...fs.readdirSync(path.join(FIXTURE, 'state')).map((n) => fs.statSync(path.join(FIXTURE, 'state', n)).mtimeMs));
  return buildSnapshot(FIXTURE, { tmux: false, now: newest + 60000, ...opts });
}
const ids = (list) => list.map((x) => (x.type === 'call' ? 'call:' + x.b.id : x.type === 'task' ? x.t.id : x.id));

test('groupBoard: the fixture fleet lands in Needs you / Working / Waiting / Done', async () => {
  const snap = await fixtureSnapshot();
  const g = board.groupBoard(snap);
  assert.deepEqual(ids(g.needs), ['gamma-decision', 'delta-block', 'call:pick-beacon-color', 'call:drop-legacy-decision'],
    'decisions before blockers, then the queued questions');
  assert.deepEqual(ids(g.working).sort(), ['alpha-fix', 'epsilon-resume'], 'a resolved blocker is back to working');
  assert.deepEqual(ids(g.waiting), ['zeta-new'], 'no status yet waits');
  assert.deepEqual(ids(g.done), ['beta-scout']);
  assert.deepEqual(g.quiet, []);
  assert.deepEqual(g.mates.map((t) => t.id), ['north-mate'], 'second mates are not cards');
  assert.deepEqual(g.vacant.map((r) => r.id), ['south-mate']);
  assert.deepEqual(g.queue.map((q) => q.b.id), ['tide-cache', null], 'queued, not captain calls, not ticked');
  assert.equal(g.queue[0].index, 0, 'the queue index points into backlog.queued');
  assert.deepEqual(g.projects, ['harbor-app', 'lighthouse-api']);
  assert.deepEqual(g.counts, { needs: 4, working: 2, waiting: 1, quiet: 0, done: 1, queue: 2 });
});

test('groupBoard: quiet workers leave their column for Quiet, whatever their state', async () => {
  const snap = await fixtureSnapshot();
  for (const t of snap.tasks) if (t.id === 'gamma-decision' || t.id === 'alpha-fix') t.stale = true;
  const g = board.groupBoard(snap);
  assert.deepEqual(g.quiet.map((t) => t.id).sort(), ['alpha-fix', 'gamma-decision']);
  assert.ok(!ids(g.needs).includes('gamma-decision'), 'a quiet decision is not shouting for attention');
  assert.equal(g.counts.waiting, 3, 'the Waiting count includes quiet workers');
  assert.equal(board.columnOf({ state: 'failed' }), 'needs');
  assert.equal(board.columnOf({ state: 'paused' }), 'waiting');
  assert.equal(board.columnOf({ state: 'done', stale: true }), 'quiet');
});

test('groupBoard: project and search filters apply to workers and queue items', async () => {
  const snap = await fixtureSnapshot();
  const g = board.groupBoard(snap, { project: 'Lighthouse-API' });
  assert.deepEqual(ids(g.needs), ['gamma-decision', 'delta-block'], 'queue items without a repo tag only show under All projects');
  assert.deepEqual(g.working, []);
  assert.deepEqual(g.queue, []);
  const h = board.groupBoard(snap, { project: 'harbor-app' });
  assert.deepEqual(h.queue.map((q) => q.b.id), ['tide-cache'], 'queue items match on their repo tag');
  assert.deepEqual(h.projects, ['harbor-app', 'lighthouse-api'], 'the chips always list every project');
  const s = board.groupBoard(snap, { match: (t) => t.id === 'alpha-fix', matchItem: () => false });
  assert.deepEqual(ids(s.working), ['alpha-fix']);
  assert.deepEqual(s.needs, []);
  assert.equal(s.counts.done, 0);
});

test('groupBoard: an empty home gives empty columns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipdeck-board-'));
  try {
    const g = board.groupBoard(await buildSnapshot(dir, { tmux: false }));
    for (const k of ['needs', 'working', 'waiting', 'quiet', 'done', 'queue', 'mates', 'vacant', 'projects']) assert.deepEqual(g[k], [], k);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('card summary drops the lettered options (they are buttons) and tool text skips defaults', () => {
  const t = { options: [{ letter: 'A' }, { letter: 'B' }], lastStatus: [{ note: 'the legacy beacon endpoint still has callers. Options: (A) keep it behind a flag; (B, recommended) drop it.' }] };
  assert.equal(board.cardSummary(t), 'The legacy beacon endpoint still has callers.');
  assert.equal(board.cardSummary({ options: [], lastStatus: [{ note: 'PR 42 opened, waiting on CI' }] }), 'PR 42 opened, waiting on CI');
  assert.equal(board.cardSummary({ lastStatus: [] }), '');
  assert.equal(board.cardSummary({ lastStatus: [{ note: 'x'.repeat(400) }] }).length, 160);
  assert.equal(board.toolText({ harness: 'claude', model: 'default', effort: 'high' }), 'Claude · high');
  assert.equal(board.toolText({ harness: 'codex', model: 'gpt-sample', effort: 'medium' }), 'Codex · gpt-sample · medium');
  assert.equal(board.toolText({ config: { harness: 'claude', model: 'claude-opus-5-5', effort: 'auto' } }), 'Claude · claude-opus-5-5');
});
