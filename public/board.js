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

  // ---------- the Board ----------
  // Columns, left to right. Quiet workers sit under Waiting; the queue's next items too.
  const COLUMNS = [
    { key: 'needs', title: 'Needs you', flag: 'k' },
    { key: 'working', title: 'Working', flag: 'p' },
    { key: 'waiting', title: 'Waiting', flag: 'x' },
    { key: 'done', title: 'Done', flag: 'c' },
  ];
  const NEEDS_RANK = { 'needs-decision': 0, blocked: 1, failed: 2 };

  // Which column a worker belongs in: needs (decision, blocked, failed), working, waiting
  // (paused, no update yet), done, or quiet (no activity for days, whatever its state).
  function columnOf(t) {
    if (t.stale) return 'quiet';
    const tone = toneOf(t.state);
    if (tone === 'needs' || tone === 'blocked' || tone === 'failed') return 'needs';
    if (tone === 'working' || tone === 'done') return tone;
    return 'waiting';
  }

  const byRecent = (key) => (a, b) => (b[key] || 0) - (a[key] || 0) || String(a.id).localeCompare(String(b.id));
  const sameProject = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  // Groups a /api/fleet snapshot for the Board.
  // opts.project: only that project (queue items match on their repo tag);
  // opts.match(task) / opts.matchItem(item): the search filter.
  // Returns { needs: [{ type: 'task', t } | { type: 'call', b }], working, waiting, quiet, done: [task],
  //   queue: [{ b, index }], mates: [task], vacant: [registry entry], projects: [name], counts }.
  function groupBoard(snap, opts = {}) {
    const match = opts.match || (() => true);
    const matchItem = opts.matchItem || (() => true);
    const inProject = (p) => !opts.project || sameProject(p, opts.project);
    const tasks = (snap.tasks || []).filter((t) => t.kind !== 'secondmate');
    const out = { needs: [], working: [], waiting: [], quiet: [], done: [], queue: [], mates: [], vacant: [] };
    for (const t of tasks) {
      if (!inProject(t.project) || !match(t)) continue;
      out[columnOf(t)].push(t);
    }
    out.needs.sort((a, b) => NEEDS_RANK[a.state] - NEEDS_RANK[b.state] || byRecent('lastActivity')(a, b));
    out.needs = out.needs.map((t) => ({ type: 'task', t }));
    out.working.sort(byRecent('lastActivity'));
    out.waiting.sort(byRecent('lastActivity'));
    out.quiet.sort(byRecent('lastActivity'));
    out.done.sort(byRecent('statusMtime'));
    const backlog = snap.backlog || {};
    for (const b of backlog.calls || []) {
      if (!inProject(b.tags && b.tags.repo) || !matchItem(b)) continue;
      out.needs.push({ type: 'call', b });
    }
    (backlog.queued || []).forEach((b, index) => {
      if (b.captainCall || b.checked || !inProject(b.tags && b.tags.repo) || !matchItem(b)) return;
      out.queue.push({ b, index });
    });
    out.mates = (snap.tasks || []).filter((t) => t.kind === 'secondmate' && match(t));
    const running = new Set(out.mates.map((t) => t.id));
    out.vacant = ((snap.secondmates && snap.secondmates.registry) || []).filter((r) => !running.has(r.id));
    const names = new Map();
    for (const t of tasks) if (t.project && t.project !== 'unassigned') names.set(t.project.toLowerCase(), t.project);
    for (const b of [...(backlog.calls || []), ...(backlog.queued || [])]) {
      const r = b.tags && b.tags.repo;
      if (r && !names.has(r.toLowerCase())) names.set(r.toLowerCase(), r);
    }
    out.projects = [...names.values()].sort((a, b) => a.localeCompare(b));
    out.counts = { needs: out.needs.length, working: out.working.length, waiting: out.waiting.length + out.quiet.length, quiet: out.quiet.length, done: out.done.length, queue: out.queue.length };
    return out;
  }

  // The card's one or two sentences: the worker's latest note, without the lettered options
  // (they are buttons on the card) and capped for the card.
  function cardSummary(t, max = 160) {
    const last = t && t.lastStatus && t.lastStatus.length ? t.lastStatus[t.lastStatus.length - 1] : null;
    let s = String((last && last.note) || '').replace(/\s+/g, ' ').trim();
    if (t && t.options && t.options.length) {
      const cut = /\s*(?:\boptions?\s*:|\(A(?:,[^)]*)?\)|\boption A\b|(?:^|\s)A\)\s)/i.exec(s);
      if (cut && cut.index > 0) s = s.slice(0, cut.index).replace(/[\s,;:-]+$/, '');
      if (s && !/[.!?]$/.test(s)) s += '.';
    }
    if (!s) return '';
    s = s[0].toUpperCase() + s.slice(1);
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }

  // "Claude · opus · high": the tool, a non-default model and the effort.
  function toolText(t) {
    const c = (t && t.config) || {};
    const harness = c.harness || t.harness || 'claude';
    const model = c.model || t.model;
    const effort = c.effort || t.effort;
    const name = harness[0].toUpperCase() + harness.slice(1);
    return [name, model && model !== 'default' ? model : null, effort && effort !== 'auto' ? effort : null].filter(Boolean).join(' · ');
  }

  const api = { TONES, TONE_ORDER, STATE_TONE, COLUMNS, toneOf, flagOf, statusOf, callStatus, quietDays, columnOf, groupBoard, cardSummary, toolText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShipDeckBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
