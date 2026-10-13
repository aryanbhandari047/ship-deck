'use strict';
// Plain-language labels shared by the page and the tests: message kinds, worker
// states and the one-sentence card summary. API field names stay unchanged.

(function (root) {
  const DAY_MS = 86400000;

  // Message (order) kinds as the captain reads them.
  const KIND_LABEL = {
    chat: 'Message', cleanup: 'Clean up worker', merge: 'Merge pull request', answer: 'Answer', decision: 'Your decision',
    status: 'Status check', 'new-task': 'New task', 'cleanup-done': 'Clean up finished workers', 'backlog-start': 'Start from queue',
    'backlog-answer': 'Your decision', config: 'Settings change', order: 'Message',
  };
  // Short pill text per worker state; "stale" is shown as quiet.
  const STATE_LABEL = {
    'working': 'working', 'needs-decision': 'needs you', 'blocked': 'blocked', 'paused': 'paused',
    'done': 'done', 'failed': 'failed', 'unknown': 'starting', 'resolved': 'working', 'stale': 'quiet',
  };
  // Message lifecycle: pending -> acknowledged -> done/declined.
  const MESSAGE_STATUS = { pending: 'waiting', acknowledged: 'seen', done: 'done', declined: 'declined' };

  const kindLabel = (kind) => KIND_LABEL[kind] || 'Message';
  const stateLabel = (state) => STATE_LABEL[state] || state || 'starting';
  const messageStatus = (status) => MESSAGE_STATUS[status] || status || '';

  // First clause of a status note: up to the first sentence end, ';', ':', ' - ', ', ' or ' (',
  // capped at max characters.
  function firstClause(note, max = 60) {
    let s = String(note || '').replace(/\s+/g, ' ').trim();
    const cut = /[.;:!?](?=\s|$)|\s[-–—]\s|,\s|\s\(/.exec(s);
    if (cut && cut.index > 0) s = s.slice(0, cut.index);
    s = s.replace(/[\s,.;:]+$/, '');
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }

  // Whole days since ms (at least 1), for "Quiet for N days".
  function quietDays(lastActivity, now = Date.now()) {
    if (!lastActivity) return null;
    return Math.max(1, Math.floor((now - lastActivity) / DAY_MS));
  }
  function quietText(lastActivity, now) {
    const n = quietDays(lastActivity, now);
    return n === null ? 'Quiet' : `Quiet for ${n} day${n === 1 ? '' : 's'}`;
  }

  // One sentence for a worker card. t: { state, stale, lastActivity, lastStatus: [{ note }] }.
  function summary(t, now) {
    const last = t && t.lastStatus && t.lastStatus.length ? t.lastStatus[t.lastStatus.length - 1] : null;
    const reason = firstClause(last && last.note);
    const why = (word) => (reason ? `${word}: ${reason}` : word);
    let s;
    switch (t && t.state) {
      case 'working': s = 'Working'; break;
      case 'needs-decision': s = 'Waiting on your call'; break;
      case 'blocked': s = why('Blocked'); break;
      case 'paused': s = why('Paused'); break;
      case 'done': s = 'Done - ready for cleanup'; break;
      case 'failed': s = 'Failed'; break;
      default: s = 'Starting up';
    }
    return t && t.stale ? `${quietText(t.lastActivity, now)} · ${s}` : s;
  }

  // Settings picker for one field: "Current (x)" first with value '' (selected), then the other
  // allow-listed values, so Apply stays off until the captain picks a real change.
  function configChoices(list, current, pending) {
    const cur = current || 'default';
    const label = `Current (${cur}${pending ? `, ${pending} on relaunch` : ''})`;
    return { selected: '', options: [['', label], ...(list || []).filter((v) => v !== cur && v !== pending).map((v) => [v, v])] };
  }

  const api = { configChoices, KIND_LABEL, STATE_LABEL, MESSAGE_STATUS, kindLabel, stateLabel, messageStatus, firstClause, quietDays, quietText, summary };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShipDeckLabels = api;
})(typeof window !== 'undefined' ? window : globalThis);
