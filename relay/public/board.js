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
  // Projects compare by their last path part, so a queue tag "org/repo" matches the project "repo".
  const projectKey = (p) => String(p || '').trim().toLowerCase().replace(/\/+$/, '').split('/').pop();
  const sameProject = (a, b) => projectKey(a) === projectKey(b);

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
    for (const t of tasks) if (t.project && t.project !== 'unassigned') names.set(projectKey(t.project), t.project);
    for (const b of [...(backlog.calls || []), ...(backlog.queued || [])]) {
      const r = b.tags && b.tags.repo;
      if (r && !names.has(projectKey(r))) names.set(projectKey(r), r.replace(/\/+$/, '').split('/').pop());
    }
    out.projects = [...names.values()].sort((a, b) => a.localeCompare(b));
    const calls = out.needs.filter((x) => x.type === 'call').length;
    out.counts = { needs: out.needs.length, workers: out.needs.length - calls, calls, working: out.working.length, waiting: out.waiting.length + out.quiet.length, quiet: out.quiet.length, done: out.done.length, queue: out.queue.length };
    return out;
  }

  // ---------- delivery: the path a worker's change takes, and how far along it is ----------
  // firstmate delivery modes (state/<id>.meta mode=); a scout writes a report instead.
  const PATHS = {
    'no-mistakes': { word: 'Full review pipeline, then a pull request', steps: [['build', 'Build'], ['validate', 'Validate'], ['pr', 'Pull request'], ['checks', 'Checks'], ['merge', 'Merge']] },
    'direct-PR': { word: 'Pull request straight away', steps: [['build', 'Build'], ['pr', 'Pull request'], ['merge', 'Merge']] },
    'local-only': { word: 'Local branch, merged on this computer', steps: [['build', 'Build'], ['branch', 'Ready branch'], ['merge', 'Merge']] },
    scout: { word: 'Report only, no code change', steps: [['investigate', 'Investigate'], ['report', 'Report']] },
  };
  const PR_RE = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;
  // Checks as the worker last reported them, newest note first: green, failing or running.
  function ciOf(notes) {
    for (const n of notes) {
      if (/\b(?:ci|checks?)\b[^.\n]{0,30}\b(?:fail(?:s|ed|ing)?|red|broken)\b/i.test(n)) return 'failed';
      if (/\b(?:ci|checks?)\b[^.\n]{0,30}\b(?:green|pass(?:es|ed|ing)?)\b|\ball checks pass/i.test(n)) return 'green';
      if (/\b(?:ci|checks?)\b[^.\n]{0,30}\b(?:running|pending|in progress|re-?running|queued)\b|\b(?:waiting|wait) (?:on|for) (?:ci|checks)\b/i.test(n)) return 'running';
    }
    return null;
  }
  // { path, word, steps: [{ key, label, state: done|now|wait|fail|todo }], at, label, ci, pr, merge }
  // from the task's kind, mode, PR and its own status notes. null for second mates.
  function deliveryOf(t) {
    if (!t || t.kind === 'secondmate') return null;
    const notes = (t.lastStatus || []).map((e) => String(e.note || '')).reverse();
    const latest = notes[0] || '';
    const failed = t.state === 'failed';
    const done = t.state === 'done';
    let path = t.kind === 'scout' ? 'scout' : PATHS[t.mode] ? t.mode : null;
    const def = PATHS[path || 'direct-PR'];
    const pr = t.pr || ((notes.join('\n').match(PR_RE) || [])[0]) || null;
    const ci = path === 'scout' ? null : ciOf(notes);
    const merged = /\b(?:merged|landed)\b/i.test(latest) && !/\b(?:not|un)[- ]?merged\b|\bbefore (?:it is )?merged\b/i.test(latest);
    const K = def.steps.map(([k]) => k);
    let at = 0;
    if (path === 'scout') at = t.hasReport || done ? 2 : 0;
    else if (merged) at = K.length;
    else if (path === 'no-mistakes') {
      if (ci === 'green' || (done && pr)) at = K.indexOf('merge');
      else if (pr) at = K.indexOf('checks');
      else if (/\b(?:no-mistakes|pipeline|validat\w*|gate|review step)\b/i.test(notes.join('\n'))) at = K.indexOf('validate');
    } else if (path === 'local-only') {
      if (done || /\bready\b[^.\n]{0,20}\bbranch\b|\bbranch\b[^.\n]{0,20}\bready\b/i.test(latest)) at = K.indexOf('merge');
    } else if (pr) at = K.indexOf('merge');
    const steps = def.steps.map(([key, label], i) => {
      let state = i < at ? 'done' : i > at ? 'todo' : 'now';
      if (state === 'now' && (failed || (key === 'checks' && ci === 'failed'))) state = 'fail';
      else if (state === 'now' && key === 'merge') state = 'wait';
      return { key, label, state };
    });
    const yolo = !!t.yolo;
    const words = {
      build: 'Building', validate: 'Validating', pr: 'Opening a pull request', branch: 'Preparing the branch', investigate: 'Investigating',
      checks: ci === 'failed' ? 'Checks failing' : ci === 'running' ? 'Checks running' : 'Waiting on checks',
      merge: path === 'local-only' ? (yolo ? 'Branch ready, first mate merges' : 'Branch ready to merge') : path === 'no-mistakes' ? (yolo ? 'Checks green, first mate merges' : 'Checks green, ready to merge') : (yolo ? 'Pull request open, first mate merges' : 'Pull request open'),
    };
    const label = failed ? 'Stopped' : at >= K.length ? (path === 'scout' ? (t.hasReport ? 'Report ready' : 'Finished') : 'Merged') : words[K[at]];
    return { path, word: path ? def.word : 'Delivery path not recorded', steps, at, label, ci, pr, merge: path === 'scout' ? null : yolo ? 'firstmate' : 'captain' };
  }

  // Titles keep their words, not raw links: a Linear issue link becomes its key, a pull request
  // link "repo#N", any other link its host; a key repeated right after itself is dropped.
  function tidyTitle(s) {
    let out = String(s || '')
      .replace(/https?:\/\/linear\.app\/[^\s)]*?\/issue\/([A-Za-z]+-\d+)[^\s)]*/g, (m, k) => k.toUpperCase())
      .replace(/https?:\/\/github\.com\/[^\s/)]+\/([^\s/)]+)\/pull\/(\d+)[^\s)]*/g, '$1#$2')
      .replace(/https?:\/\/(?:www\.)?([^\s/)]+)[^\s)]*/g, '$1');
    out = out.replace(/\b([A-Z]+-\d+)\s*(?:[-–—:]\s*)?\(?\1\b\)?/g, '$1');
    return out.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
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

  const api = { TONES, TONE_ORDER, STATE_TONE, COLUMNS, PATHS, toneOf, flagOf, statusOf, callStatus, quietDays, columnOf, groupBoard, cardSummary, toolText, projectKey, deliveryOf, tidyTitle };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShipDeckBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
