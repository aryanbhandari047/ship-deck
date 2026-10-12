'use strict';
// Resumable sessions: finds the Claude Code transcript behind the first mate and
// each crew member, read-only, under <claudeDir>/projects/<encoded-cwd>/<uuid>.jsonl,
// and remembers the mapping in ~/.ship-deck/sessions.json so ids survive cleanup.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDir, TASK_ID_RE } = require('./orders');

const SESSIONS_FILE = 'sessions.json';
const FIRST_MATE_KEY = '_firstmate'; // never a valid crew id
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEAD_BYTES = 256 * 1024;
const MAX_CANDIDATES = 12;
const SPAWN_SLACK_MS = 60 * 1000;
const LAST_SEEN_EVERY_MS = 10 * 60 * 1000;

function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

// Claude names a project dir after its cwd with separators replaced by '-'.
// Both the documented ('/' and '.') and the broader (any non-alphanumeric) forms are tried.
function encodeCwd(cwd) {
  const p = path.resolve(String(cwd)).replace(/\/+$/, '');
  return [...new Set([p.replace(/[/.]/g, '-'), p.replace(/[^A-Za-z0-9-]/g, '-')])];
}

function readHead(file, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// { cwd, sessionId, started, mentions } from the start of a transcript: started is
// its first timestamp, mentions the first crew id whose state/<id>.status the brief names.
const headCache = new Map();
function inspectTranscript(file) {
  if (headCache.has(file)) return headCache.get(file);
  const head = readHead(file);
  if (head === null) return null;
  const out = { cwd: null, sessionId: null, started: null, mentions: null };
  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.cwd === 'string' && typeof o.sessionId === 'string') { out.cwd = o.cwd; out.sessionId = o.sessionId; break; }
    } catch { /* partial or junk line */ }
  }
  const ts = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/.exec(head);
  if (ts && Number.isFinite(Date.parse(ts[1]))) out.started = Date.parse(ts[1]);
  const m = /\/state\/([a-z0-9][a-z0-9-]*)\.status/.exec(head);
  if (m) out.mentions = m[1];
  if (Buffer.byteLength(head) >= HEAD_BYTES && out.sessionId) headCache.set(file, out);
  return out;
}

// Top-level <uuid>.jsonl transcripts for a cwd, newest first.
function transcripts(claudeDir, cwd) {
  const out = [];
  for (const enc of encodeCwd(cwd)) {
    const dir = path.join(claudeDir, 'projects', enc);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || !UUID_RE.test(n.slice(0, -6))) continue;
      const file = path.join(dir, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) out.push({ file, sessionId: n.slice(0, -6), mtime: st.mtimeMs, birth: st.birthtimeMs > 0 ? st.birthtimeMs : null });
      } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const samePath = (a, b) => path.resolve(a).replace(/\/+$/, '') === path.resolve(b).replace(/\/+$/, '');

// A transcript is verified when its first lines carry the same cwd and a
// sessionId matching the file name.
function verified(c, cwd) {
  const info = inspectTranscript(c.file);
  if (!info || info.sessionId !== c.sessionId || !info.cwd || !samePath(info.cwd, cwd)) return null;
  return { ...c, mentions: info.mentions, started: info.started || c.birth || c.mtime };
}

// Worktrees are reused, so each transcript gets one owner: the crew member its
// brief names, else the task spawned most recently before the session started.
// crew: [{ id, spawn }] sharing cwd. Returns { id: newest owned session }.
function assignSessions(claudeDir, cwd, crew) {
  const out = {};
  const ids = new Set(crew.map((c) => c.id));
  const bySpawn = crew.filter((c) => c.spawn).sort((a, b) => b.spawn - a.spawn);
  for (const c of transcripts(claudeDir, cwd).slice(0, MAX_CANDIDATES * Math.max(1, crew.length))) {
    const v = verified(c, cwd);
    if (!v) continue;
    let owner = null;
    let matched = 'brief';
    if (v.mentions) owner = ids.has(v.mentions) ? v.mentions : null;
    else {
      const t = bySpawn.find((x) => x.spawn - SPAWN_SLACK_MS <= v.started);
      owner = t ? t.id : null;
      matched = 'spawn-time';
    }
    if (owner && !out[owner]) out[owner] = { sessionId: v.sessionId, cwd, file: v.file, mtime: v.mtime, matched };
  }
  return out;
}

function findCrewSession(claudeDir, { id, cwd, since }) {
  return assignSessions(claudeDir, cwd, [{ id, spawn: since || null }])[id] || null;
}

function findFirstMateSession(claudeDir, home) {
  for (const c of transcripts(claudeDir, home).slice(0, MAX_CANDIDATES)) {
    const v = verified(c, home);
    if (v) return { sessionId: v.sessionId, cwd: home, file: v.file, mtime: v.mtime, matched: 'cwd' };
  }
  return null;
}

// Spawn time of a crew member: its meta file's birth time (mtime where unsupported).
function birthMs(p) {
  try {
    const st = fs.statSync(p);
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    return null;
  }
}

// tasks: snapshot tasks ({ id, harness, worktree }). Returns { [key]: found } for
// claude sessions; other harnesses are left to the caller ("resume id unknown").
function discoverSessions({ home, tasks, claudeDir }) {
  const out = {};
  const fm = findFirstMateSession(claudeDir, home);
  if (fm) out[FIRST_MATE_KEY] = { ...fm, harness: 'claude' };
  const byCwd = new Map();
  for (const t of tasks || []) {
    if (!TASK_ID_RE.test(t.id) || !t.worktree || (t.harness && t.harness !== 'claude')) continue;
    const cwd = path.resolve(t.worktree);
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push({ id: t.id, spawn: birthMs(path.join(home, 'state', t.id + '.meta')) });
  }
  for (const [cwd, crew] of byCwd) {
    for (const [id, found] of Object.entries(assignSessions(claudeDir, cwd, crew))) out[id] = { ...found, harness: 'claude' };
  }
  return out;
}

// ---------- ~/.ship-deck/sessions.json ----------

function loadSessions(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, SESSIONS_FILE), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function saveSessions(dir, map) {
  ensureDir(dir);
  const file = path.join(dir, SESSIONS_FILE);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// Merges discovered sessions into the stored map; entries are kept after their
// task disappears. Writes only on a real change (or a stale lastSeen).
function recordSessions(dir, discovered, now = Date.now()) {
  const map = loadSessions(dir);
  let changed = false;
  for (const [key, d] of Object.entries(discovered)) {
    const prev = map[key];
    if (!prev || prev.sessionId !== d.sessionId || prev.cwd !== d.cwd) {
      const history = prev && prev.sessionId && prev.sessionId !== d.sessionId
        ? [...(prev.previous || []), { sessionId: prev.sessionId, cwd: prev.cwd, firstSeen: prev.firstSeen, lastSeen: prev.lastSeen }].slice(-10)
        : (prev && prev.previous) || undefined;
      map[key] = { sessionId: d.sessionId, cwd: d.cwd, harness: d.harness || 'claude', firstSeen: now, lastSeen: now, ...(history ? { previous: history } : {}) };
      changed = true;
    } else if (now - (prev.lastSeen || 0) > LAST_SEEN_EVERY_MS) {
      prev.lastSeen = now;
      changed = true;
    }
  }
  if (changed) saveSessions(dir, map);
  return map;
}

// Shell-safe resume command for a session.
function resumeCommand(cwd, sessionId) {
  if (!cwd || !UUID_RE.test(String(sessionId || ''))) return null;
  return `cd '${String(cwd).replace(/'/g, `'\\''`)}' && claude --resume ${sessionId}`;
}

// Session lookups cached for a short while: the server polls every few seconds.
function createTracker({ home, claudeDir, ordersDir, ttlMs = 15000 }) {
  let at = 0;
  let map = null;
  return {
    get(tasks, now = Date.now()) {
      if (!map || now - at > ttlMs) {
        at = now;
        try {
          map = recordSessions(ordersDir, discoverSessions({ home, tasks, claudeDir }), now);
        } catch {
          map = map || loadSessions(ordersDir);
        }
      }
      return map;
    },
    invalidate() { map = null; },
  };
}

module.exports = {
  SESSIONS_FILE,
  FIRST_MATE_KEY,
  defaultClaudeDir,
  encodeCwd,
  inspectTranscript,
  transcripts,
  assignSessions,
  findCrewSession,
  findFirstMateSession,
  discoverSessions,
  loadSessions,
  saveSessions,
  recordSessions,
  resumeCommand,
  createTracker,
};
