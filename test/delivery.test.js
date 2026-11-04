'use strict';
// Delivery tracks (public/board.js deliveryOf): the path a worker's change takes (firstmate's
// delivery mode or a scout's report) and how far it has got, read only from the worker's own
// record and status notes. Plus tidy titles and the new snapshot facts (yolo, X mode).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const board = require('../public/board');
const { buildSnapshot } = require('../lib/fleet');

const notes = (...n) => n.map((note) => ({ state: 'working', note }));
const track = (t) => {
  const d = board.deliveryOf(t);
  return d && { label: d.label, steps: d.steps.map((s) => `${s.key}:${s.state}`).join(' '), ci: d.ci, merge: d.merge };
};

test('no-mistakes ship: build, validate, pull request, checks, merge', () => {
  const base = { kind: 'ship', mode: 'no-mistakes', state: 'working' };
  assert.deepEqual(track({ ...base, lastStatus: notes('started on the brief') }),
    { label: 'Building', steps: 'build:now validate:todo pr:todo checks:todo merge:todo', ci: null, merge: 'captain' });
  assert.equal(track({ ...base, lastStatus: notes('implementation committed', 'no-mistakes run parked at the lint gate') }).label, 'Validating');
  assert.deepEqual(track({ ...base, pr: 'https://github.com/o/r/pull/42', lastStatus: notes('PR 42 opened, waiting on CI') }),
    { label: 'Checks running', steps: 'build:done validate:done pr:done checks:now merge:todo', ci: 'running', merge: 'captain' });
  assert.equal(track({ ...base, pr: 'x', lastStatus: notes('CI failed on lint') }).steps.split(' ')[3], 'checks:fail');
  // done means checks green by protocol; the newest CI word wins over older ones
  const green = track({ ...base, state: 'done', pr: 'x', lastStatus: notes('checks running', 'done: PR https://github.com/o/r/pull/9 checks green', 'paused: waiting for labels') });
  assert.equal(green.label, 'Checks green, ready to merge');
  assert.equal(green.ci, 'green');
  assert.equal(green.steps, 'build:done validate:done pr:done checks:done merge:wait');
  assert.equal(track({ ...base, state: 'done', pr: 'x', yolo: true, lastStatus: notes('done: checks green') }).merge, 'firstmate', 'yolo: the first mate merges');
  assert.equal(track({ ...base, state: 'done', pr: 'x', lastStatus: notes('done: PR merged') }).label, 'Merged');
  assert.notEqual(track({ ...base, pr: 'x', lastStatus: notes('waiting before it is merged') }).label, 'Merged');
});

test('direct-PR, local-only, unknown mode, failed and scouts', () => {
  const pr = { kind: 'ship', mode: 'direct-PR', state: 'done', lastStatus: notes('done: PR https://github.com/o/r/pull/151 updated') };
  const d = board.deliveryOf(pr);
  assert.equal(d.pr, 'https://github.com/o/r/pull/151', 'a PR link in a note counts when the record has none');
  assert.equal(d.label, 'Pull request open');
  assert.equal(track({ kind: 'ship', mode: 'local-only', state: 'done', lastStatus: notes('done: clean branch') }).steps, 'build:done branch:done merge:wait');
  assert.equal(track({ kind: 'ship', mode: 'local-only', state: 'working', yolo: true, lastStatus: notes('branch ready') }).label, 'Branch ready, first mate merges');
  const unknown = board.deliveryOf({ kind: 'ship', state: 'failed', lastStatus: notes('crashed') });
  assert.equal(unknown.path, null);
  assert.equal(unknown.word, 'Delivery path not recorded');
  assert.equal(unknown.label, 'Stopped');
  assert.equal(unknown.steps[0].state, 'fail');
  assert.deepEqual(track({ kind: 'scout', state: 'working', lastStatus: notes('reading the logs; checks green elsewhere') }),
    { label: 'Investigating', steps: 'investigate:now report:todo', ci: null, merge: null });
  assert.equal(track({ kind: 'scout', state: 'done', hasReport: true, lastStatus: [] }).label, 'Report ready');
  assert.equal(board.deliveryOf({ kind: 'secondmate' }), null);
  assert.equal(board.deliveryOf(null), null);
  for (const p of Object.values(board.PATHS)) assert.match(p.word, /^[A-Z]/);
});

test('titles keep words, not raw links', () => {
  assert.equal(board.tidyTitle('PS-326 (https://linear.app/acme/issue/PS-326) FE surface'), 'PS-326 FE surface');
  assert.equal(board.tidyTitle('OS-5077 - https://linear.app/acme/issue/OS-5077/upload-errors'), 'OS-5077');
  assert.equal(board.tidyTitle('Keep-awake https://github.com/o/ship-deck/pull/10 (merged)'), 'Keep-awake ship-deck#10 (merged)');
  assert.equal(board.tidyTitle('See https://example.com/a?b=1 now'), 'See example.com now');
  assert.equal(board.tidyTitle('Fix the lighthouse crash'), 'Fix the lighthouse crash');
  assert.equal(board.tidyTitle(null), '');
});

test('snapshot: yolo, X-linked workers and X mode come from the home, read only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shipdeck-delivery-'));
  try {
    fs.mkdirSync(path.join(home, 'state', 'x-inbox'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'a.meta'), 'kind=ship\nmode=no-mistakes\nyolo=on\nx_request=r-1\n');
    fs.writeFileSync(path.join(home, 'state', 'b.meta'), 'kind=scout\nyolo=off\n');
    let snap = await buildSnapshot(home, { tmux: false });
    assert.deepEqual(snap.tasks.map((t) => [t.id, t.yolo, t.fromX]), [['a', true, true], ['b', false, false]]);
    assert.deepEqual(snap.xMode, { on: false, pending: 0 });
    fs.writeFileSync(path.join(home, 'state', 'x-watch.check.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(home, 'state', 'x-inbox', 'r-2.json'), '{}');
    snap = await buildSnapshot(home, { tmux: false });
    assert.deepEqual(snap.xMode, { on: true, pending: 1 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
