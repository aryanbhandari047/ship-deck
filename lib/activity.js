'use strict';
// First mate activity feed: tails the first mate's own Claude Code transcript
// (read-only; same discovery as lib/sessions.js) and turns each assistant
// tool_use, its tool_result and short text replies into compact feed events.

const fs = require('node:fs');
const path = require('node:path');
const sessions = require('./sessions');

const MAX_EVENTS = 200;
const TAIL_BYTES = 1024 * 1024; // first look at a transcript: only its last 1 MB
const READ_CAP = 8 * 1024 * 1024; // bytes read per poll at most
const DISCOVER_EVERY_MS = 5000;
const RECENT_MS = 20 * 1000; // a transcript line this recent = working
const RUNNING_STALE_MS = 10 * 60 * 1000; // an unanswered tool_use older than this no longer counts
const TEXT_CHARS = 140;
const SECRET_KEY = /pass|token|secret|key|cookie|auth|credential|session/i;

const oneLine = (s, n = TEXT_CHARS) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const base = (p) => (typeof p === 'string' && p ? path.basename(p) : '');

// Input with every secret-looking field dropped; summaries only ever read from this.
function safeInput(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) if (!SECRET_KEY.test(k)) out[k] = v;
  return out;
}

// Masks inline credentials in a shell command before it can be expanded in the UI.
function scrubCommand(cmd) {
  const NAME = '[A-Za-z0-9_-]*(?:pass|token|secret|api[_-]?key|cookie|auth|credential)[A-Za-z0-9_-]*';
  return String(cmd || '')
    .replace(/\b(authorization|cookie|x-api-key)(\s*:\s*)(bearer\s+|basic\s+)?[^\s'"]+/gi, (m, k, sep, kind) => `${k}${sep}${kind || ''}•••`)
    .replace(new RegExp(`\\b(${NAME})=(['"]?)[^\\s'"]+\\2`, 'gi'), (m, k, q) => `${k}=${q}•••${q}`)
    .replace(new RegExp(`(--?${NAME})(\\s+)(['"]?)[^\\s'"-][^\\s'"]*\\3`, 'gi'), (m, k, sp, q) => `${k}${sp}${q}•••${q}`)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|xox[abpr]-[A-Za-z0-9-]{8,})/g, '•••');
}

// { icon, label, detail? } for one tool_use block.
function describeTool(name, rawInput) {
  const input = safeInput(rawInput);
  const n = String(name || 'tool');
  if (n === 'Bash') {
    return { icon: 'shell', label: oneLine(input.description) || 'Running a shell command', detail: input.command ? scrubCommand(input.command).slice(0, 4000) : null };
  }
  const browser = /^mcp__(?:claude-in-chrome|plugin_chrome-devtools[^_]*_chrome-devtools|chrome-devtools)__(.+)$/.exec(n);
  if (browser) {
    const action = browser[1];
    if (action === 'navigate' || action === 'navigate_page' || action === 'new_page') return { icon: 'browser', label: `Browser: ${action}${input.url ? ' ' + oneLine(input.url, 120) : ''}` };
    if (action === 'find') return { icon: 'browser', label: `Browser: find${input.query ? ' "' + oneLine(input.query, 80) + '"' : ''}` };
    if (action === 'computer') {
      const a = typeof input.action === 'string' ? input.action : 'act';
      if (/type/i.test(a)) return { icon: 'browser', label: 'Browser: typing…' };
      return { icon: 'browser', label: `Browser: ${a.replace(/_/g, ' ')}` };
    }
    return { icon: 'browser', label: `Browser: ${action.replace(/_/g, ' ')}` };
  }
  if (n === 'Read') return { icon: 'read', label: `Reading ${base(input.file_path) || 'a file'}` };
  if (n === 'Edit' || n === 'MultiEdit') return { icon: 'edit', label: `Editing ${base(input.file_path) || 'a file'}` };
  if (n === 'Write') return { icon: 'write', label: `Writing ${base(input.file_path) || 'a file'}` };
  if (n === 'Agent' || n === 'Task') return { icon: 'agent', label: `Delegated: ${oneLine(input.description, 100) || 'a subagent'}` };
  if (n === 'Artifact') return { icon: 'publish', label: `Publishing ${oneLine(input.title, 80) || base(input.file_path) || 'an artifact'}` };
  return { icon: 'tool', label: n };
}

const tsOf = (o) => {
  const t = Date.parse(o && o.timestamp);
  return Number.isFinite(t) ? t : null;
};

// Tracker over the newest first mate transcript. poll() reads only new bytes;
// a line without its trailing newline is left for the next poll.
function createActivity({ home, claudeDir, now = () => Date.now() }) {
  let file = null;
  let sessionId = null;
  let offset = 0;
  let skipPartial = false;
  let discoveredAt = 0;
  let lastLineAt = 0;
  let rev = 0;
  let seq = 0;
  const epoch = Date.now().toString(36);
  let events = [];
  const byToolId = new Map();

  function push(e) {
    e.seq = ++seq;
    e.rev = ++rev;
    events.push(e);
    if (e.toolId) byToolId.set(e.toolId, e);
    while (events.length > MAX_EVENTS) {
      const old = events.shift();
      if (old.toolId) byToolId.delete(old.toolId);
    }
  }

  function ingest(o) {
    if (!o || typeof o !== 'object' || o.isSidechain) return;
    const ts = tsOf(o);
    if (ts) lastLineAt = Math.max(lastLineAt, ts);
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) return;
    if (o.type === 'assistant') {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use') {
          if (b.id && byToolId.has(b.id)) continue; // a streamed message repeats its blocks
          push({ kind: 'tool', ts, tool: String(b.name || 'tool'), toolId: b.id || null, status: 'running', duration: null, ...describeTool(b.name, b.input) });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          push({ kind: 'text', ts, label: oneLine(b.text) });
        }
      }
    } else if (o.type === 'user') {
      for (const b of content) {
        if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
        const e = byToolId.get(b.tool_use_id);
        if (!e || e.status !== 'running') continue;
        e.status = b.is_error ? 'failed' : 'done';
        e.duration = ts && e.ts ? Math.max(0, ts - e.ts) : null;
        e.rev = ++rev;
      }
    }
  }

  function switchTo(found) {
    for (const e of events) if (e.status === 'running') { e.status = 'unknown'; e.rev = ++rev; }
    byToolId.clear();
    if (file) push({ kind: 'session', ts: found.mtime || null, label: `New first mate session ${found.sessionId.slice(0, 8)}` });
    file = found.file;
    sessionId = found.sessionId;
    lastLineAt = 0;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* vanished */ }
    offset = Math.max(0, size - TAIL_BYTES);
    skipPartial = offset > 0; // started mid-file: drop the cut first line
  }

  function readNew() {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < offset) { offset = 0; skipPartial = false; } // truncated or replaced: read again from the top
      if (size === offset) return;
      const len = Math.min(size - offset, READ_CAP);
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, offset);
      const chunk = buf.subarray(0, got);
      let from = 0;
      if (skipPartial) {
        const nl = chunk.indexOf(10);
        if (nl < 0) { offset += got; return; }
        from = nl + 1;
        skipPartial = false;
      }
      const lastNl = chunk.lastIndexOf(10);
      if (lastNl < from) {
        // No complete line yet; a line longer than the read cap is skipped.
        if (got >= READ_CAP) { offset += got; skipPartial = true; } else offset += from;
        return;
      }
      for (const line of chunk.subarray(from, lastNl).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { ingest(JSON.parse(line)); } catch { /* junk line */ }
      }
      offset += lastNl + 1;
    } catch {
      /* unreadable right now; try again next poll */
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  function poll() {
    const t = now();
    if (!file || t - discoveredAt > DISCOVER_EVERY_MS) {
      discoveredAt = t;
      let found = null;
      try { found = sessions.findFirstMateSession(claudeDir, home); } catch { /* none */ }
      if (found && found.file !== file) switchTo(found);
    }
    if (file) readNew();
  }

  function state() {
    const t = now();
    const running = events.some((e) => e.status === 'running' && (!e.ts || t - e.ts < RUNNING_STALE_MS));
    const recent = lastLineAt > 0 && t - lastLineAt < RECENT_MS;
    return { working: running || recent, running, lastAt: lastLineAt || null };
  }

  // Events changed since cursor `since` (a rev from this epoch); everything otherwise.
  function view(since, sinceEpoch) {
    poll();
    const full = sinceEpoch !== epoch || !Number.isFinite(since) || since > rev;
    const list = full ? events : events.filter((e) => e.rev > since);
    return {
      epoch, rev, full, sessionId, ...state(),
      events: list.map(({ toolId, ...e }) => e),
    };
  }

  return { poll, view, state };
}

module.exports = { createActivity, describeTool, safeInput, scrubCommand, MAX_EVENTS };
