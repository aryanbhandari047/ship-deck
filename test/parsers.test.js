'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const f = require('../lib/fleet');

const FIX = path.join(__dirname, 'fixtures', 'home');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');

test('parseMeta reads key=value lines and skips junk', () => {
  const m = f.parseMeta(read('state/gamma-decision.meta'));
  assert.equal(m.window, 'fleet:fm-gamma-decision');
  assert.equal(m.kind, 'ship');
  assert.equal(m.mode, 'local-only');
  assert.equal(m.empty, '');
  assert.ok(!('# comment lines are ignored' in m));
  assert.equal(Object.keys(m).length, 5);

  const a = f.parseMeta(read('state/alpha-fix.meta'));
  assert.equal(a.pr, 'https://github.com/example-org/harbor-app/pull/42');
  assert.equal(a.pr_head.length, 40);
  assert.deepEqual(f.parseMeta(''), {});
  assert.deepEqual(f.parseMeta(null), {});
  assert.deepEqual(f.parseMeta('url=https://x/?a=b'), { url: 'https://x/?a=b' });
});

test('parseStatus keeps state lines, timestamps and keys; drops junk', () => {
  const e = f.parseStatus(read('state/alpha-fix.status'));
  assert.equal(e.length, 3);
  assert.deepEqual(e[0], { ts: '2026-01-05 09:12', state: 'working', key: null, note: 'reproduced the lighthouse crash on a clean checkout' });
  assert.equal(e[2].ts, null);
  assert.equal(e[2].note, 'PR 42 opened, waiting on CI');

  const g = f.parseStatus(read('state/gamma-decision.status'));
  assert.equal(g[1].state, 'needs-decision');
  assert.equal(g[1].key, 'keep-or-drop');
  assert.match(g[1].note, /^keep the legacy beacon endpoint/);

  const r = f.parseStatus(read('state/epsilon-resume.status'));
  assert.equal(r[0].ts, '2026-01-04 08:00:00');
  assert.equal(r[0].state, 'paused');
  assert.equal(r[1].state, 'resolved');

  // note text containing colons survives
  assert.equal(f.parseStatus('done: PR: merged at 12:30')[0].note, 'PR: merged at 12:30');
  // unknown state words are not status lines
  assert.deepEqual(f.parseStatus('note: hello\nworkingish: nope'), []);
  assert.deepEqual(f.parseStatus(null), []);
});

test('displayState maps resolved to working and empty to unknown', () => {
  assert.equal(f.displayState([]), 'unknown');
  assert.equal(f.displayState(f.parseStatus('blocked: x\nresolved: y')), 'working');
  assert.equal(f.displayState(f.parseStatus('working: x\ndone: y')), 'done');
});

test('parseBacklog splits sections loosely and flags captain calls', () => {
  const b = f.parseBacklog(read('data/backlog.md'));
  assert.deepEqual(b.captain.map((i) => i.id), ['pick-beacon-color']);
  assert.ok(b.captain[0].captainCall);
  assert.deepEqual(b.inFlight.map((i) => i.id), ['alpha-fix', 'gamma-decision']);
  assert.equal(b.inFlight[0].tags.repo, 'harbor-app');
  assert.equal(b.inFlight[0].title, 'Fix the lighthouse crash');
  assert.deepEqual(b.inFlight[0].notes, ['PR https://github.com/example-org/harbor-app/pull/42 open.']);

  assert.equal(b.queued.length, 4);
  const [tide, drop, free, checked] = b.queued;
  assert.equal(tide.id, 'tide-cache');
  assert.equal(tide.tags.after, 'alpha-fix');
  assert.equal(tide.captainCall, false);
  assert.equal(drop.captainCall, true);
  assert.equal(drop.tags.hold, 'waiting on captain (see gamma)');
  assert.equal(drop.title, 'Keep or drop the legacy endpoint (diagnose only)');
  assert.deepEqual(drop.notes, ['Origin: gamma-decision', 'Decision key: keep-or-drop']);
  assert.equal(free.id, null);
  assert.equal(free.title, 'free text item without an id');
  assert.equal(checked.checked, true);

  assert.deepEqual(b.other.map((i) => i.id), ['someday-idea']);
  assert.equal(b.done[0].id, 'beta-scout');
  assert.equal(b.done[0].tags.reported, '2026-01-02');
});

test('parseBacklog tolerates empty and heading-less input', () => {
  const empty = f.parseBacklog('');
  assert.equal(empty.queued.length, 0);
  const noHead = f.parseBacklog('- [ ] orphan - item before any heading');
  assert.equal(noHead.queued.length + noHead.other.length, 0);
});

test('parseProjects reads name, mode and description', () => {
  const p = f.parseProjects(read('data/projects.md'));
  assert.deepEqual(p.map((x) => x.name), ['harbor-app', 'lighthouse-api']);
  assert.equal(p[0].mode, 'no-mistakes');
  assert.match(p[0].description, /harbor scheduling/);
  assert.equal(p[1].mode, 'local-only');
});

test('parseSecondmates reads the registry fields', () => {
  const s = f.parseSecondmates(read('data/secondmates.md'));
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { id: 'north-mate', description: 'northern lane', home: '/tmp/sample/homes/north', scope: 'harbor work', projects: 'harbor-app' });
  assert.equal(s[1].id, 'south-mate');
  assert.equal(s[1].description, '');
  assert.equal(s[1].home, '/tmp/sample/homes/south');
});

test('briefSummary takes the first paragraph under # Task', () => {
  assert.equal(f.briefSummary(read('data/beta-scout/brief.md')),
    'Diagnose why the tide chart drifts by one hour after the daylight-saving switch.');
  assert.equal(f.briefSummary(read('data/alpha-fix/brief.md')), null);
  assert.equal(f.briefSummary('no task heading here'), null);
  assert.equal(f.briefSummary('# Task\n**Fix** the `beacon` per [the doc](http://x).'), 'Fix the beacon per the doc.');
  const long = f.briefSummary('# Task\n\n' + 'word '.repeat(100), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('projectName and parseTmuxWindows', () => {
  assert.equal(f.projectName('/a/b/projects/harbor-app/'), 'harbor-app');
  assert.equal(f.projectName(undefined), 'unassigned');
  const w = f.parseTmuxWindows('fleet:zsh\nfleet:fm-alpha-fix\n\n');
  assert.ok(w.has('fleet:fm-alpha-fix'));
  assert.equal(w.size, 2);
});

test('isStale: older than the threshold, never for done crew', () => {
  const now = Date.parse('2026-01-20T12:00:00Z');
  const day = 86400000;
  assert.equal(f.DEFAULT_STALE_DAYS, 7);
  assert.equal(f.isStale('working', now - 8 * day, now), true);
  assert.equal(f.isStale('needs-decision', now - 7 * day + 1000, now), false, 'just under 7 days');
  assert.equal(f.isStale('blocked', now - 8 * day, now, 10), false, 'configurable threshold');
  assert.equal(f.isStale('paused', now - 2 * day, now, 1.5), true, 'fractional days');
  assert.equal(f.isStale('done', now - 90 * day, now), false);
  assert.equal(f.isStale('working', null, now), false, 'no activity recorded');
});
