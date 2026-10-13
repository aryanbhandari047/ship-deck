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
