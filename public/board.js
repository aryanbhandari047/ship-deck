'use strict';
// Status as the captain sees it: every worker state maps to one tone (colour), one
// International Code of Signals flag (shape) and one sentence-case word. Shared by the
// page and the tests.

(function (root) {
  const DAY_MS = 86400000;

  // tone -> flag symbol id (#flag-<flag>), its word and what the flag means at sea.
  const TONES = {
    needs: { flag: 'k', word: 'Needs you', meaning: 'K: I wish to communicate with you' },
    blocked: { flag: 'v', word: 'Blocked', meaning: 'V: I require assistance' },
    working: { flag: 'p', word: 'Working', meaning: 'P, the Blue Peter: under way' },
    waiting: { flag: 'x', word: 'Waiting', meaning: 'X: watch for my signals' },
    done: { flag: 'c', word: 'Done', meaning: 'C: affirmative' },
    failed: { flag: 'o', word: 'Failed', meaning: 'O: man overboard' },
    quiet: { flag: 'q0', word: 'Quiet', meaning: 'Flag struck: no activity for days' },
  };
  const TONE_ORDER = ['needs', 'blocked', 'working', 'waiting', 'done', 'failed', 'quiet'];

  // firstmate state -> tone. "resolved" reads as working; no status yet reads as waiting.
  const STATE_TONE = {
    'needs-decision': 'needs', blocked: 'blocked', failed: 'failed', working: 'working', resolved: 'working',
    paused: 'waiting', unknown: 'waiting', done: 'done',
  };

  function toneOf(state, stale) {
    if (stale) return 'quiet';
    return STATE_TONE[state] || 'waiting';
  }
  function flagOf(state, stale) { return TONES[toneOf(state, stale)].flag; }

  function quietDays(lastActivity, now = Date.now()) {
    return lastActivity ? Math.max(1, Math.floor((now - lastActivity) / DAY_MS)) : null;
  }

  // The pill for one worker: { tone, flag, label }. t: { state, stale, lastActivity, kind, hasReport }.
  function statusOf(t, now) {
    const tone = toneOf(t && t.state, t && t.stale);
    let label;
    if (tone === 'quiet') {
      const n = quietDays(t.lastActivity, now);
      label = n === null ? 'Quiet' : `Quiet for ${n} day${n === 1 ? '' : 's'}`;
    } else {
      label = {
        'needs-decision': 'Your call', blocked: 'Blocked', failed: 'Failed', working: 'Working', resolved: 'Working',
        paused: 'Paused', done: t.kind === 'scout' && t.hasReport ? 'Report ready' : 'Done',
      }[t && t.state] || 'No update yet';
    }
    return { tone, flag: TONES[tone].flag, label };
  }

  // A queue item that waits on the captain.
  function callStatus() { return { tone: 'needs', flag: 'k', label: 'Queued question' }; }

  const api = { TONES, TONE_ORDER, STATE_TONE, toneOf, flagOf, statusOf, callStatus, quietDays };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShipDeckBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
