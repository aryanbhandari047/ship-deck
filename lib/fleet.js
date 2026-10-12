'use strict';
// Read-only fleet snapshot builder for Ship Deck.
//
// Every function here only reads from FM_HOME (readFileSync / statSync /
// readdirSync). Nothing in this module writes, renames or deletes files, and
// nothing runs fleet scripts. The optional tmux probe only lists windows.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const STATES = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'resolved'];
const STATUS_RE = new RegExp(
  '^(?:(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(?::\\d{2})?)\\s+)?' + // optional timestamp
  '(' + STATES.join('|') + ')' +
  '(?:\\s*\\[key=([^\\]]*)\\])?' + // optional [key=slug]
  '\\s*:\\s?(.*)$'
);

// ---------- pure parsers (unit-tested) ----------

function parseMeta(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// Parses an append-only status log into entries. Lines that do not start with a
// known state (stray shell output, wrapped text) are skipped.
function parseStatus(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = STATUS_RE.exec(line);
    if (!m) continue;
    entries.push({
      ts: m[1] ? m[1].replace('T', ' ') : null,
      state: m[2],
      key: m[3] || null,
      note: m[4].trim(),
    });
  }
  return entries;
}

// The state shown on deck. "resolved" means a decision/blocker was closed and
// the worker resumed, so it reads as working.
function displayState(entries) {
  if (!entries || !entries.length) return 'unknown';
  const s = entries[entries.length - 1].state;
  return s === 'resolved' ? 'working' : s;
}

// Parses "(key: value)" and "(since 2026-01-01)" style tags from a backlog line,
// keyed by their first word.
function parseTags(text) {
  const tags = {};
  const re = /\(([a-z][a-z-]*)(?::\s*|\s+)([^()]*(?:\([^()]*\)[^()]*)*)\)/gi;
  let m;
  while ((m = re.exec(text))) {
    const k = m[1].toLowerCase();
    if (!(k in tags)) tags[k] = m[2].trim();
  }
  return tags;
}

function sectionKey(heading) {
  const h = heading.toLowerCase();
  if (h.includes('captain')) return 'captain';
  if (h.includes('flight') || h.includes('progress') || h.includes('active')) return 'inFlight';
  if (h.includes('queue') || h.includes('todo') || h.includes('next')) return 'queued';
  if (h.includes('done') || h.includes('landed') || h.includes('complete')) return 'done';
  return null;
}

// Loose parser for the tasks-axi markdown backlog. Tolerates unknown sections,
// missing ids, indented continuation lines and arbitrary tag soup.
function parseBacklog(text) {
  const out = { captain: [], inFlight: [], queued: [], done: [], other: [] };
  let section = null;
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const h = /^#{2,3}\s+(.*)$/.exec(raw);
    if (h) {
      section = sectionKey(h[1]) || 'other';
      current = null;
      continue;
    }
    const item = /^[-*]\s+(?:\[([ xX~-])\]\s+)?(.*)$/.exec(raw);
    if (item && section) {
      const body = item[2].trim();
      const idm = /^`?([A-Za-z0-9][\w.-]*)`?\s+[-–—:]\s+(.*)$/.exec(body);
      const id = idm ? idm[1] : null;
      const rest = idm ? idm[2] : body;
      const tags = parseTags(rest);
      const title = rest
        .replace(/\s*\([a-z][a-z-]*:[^()]*(?:\([^()]*\)[^()]*)*\)/gi, '')
        .replace(/\s*\((?:since|done|reported|added|landed|due|after|until)\s+[^()]*\)/gi, '')
        .trim();
      current = {
        id,
        title: title || rest,
        checked: item[1] ? item[1].toLowerCase() === 'x' : false,
        tags,
        section,
        captainCall: section === 'captain' || tags.kind === 'captain' || tags['hold-kind'] === 'captain',
        notes: [],
      };
      out[section].push(current);
      continue;
    }
    if (current && /^\s+\S/.test(raw) && current.notes.length < 6) current.notes.push(raw.trim());
  }
  return out;
}

// data/projects.md: "- name [mode] - description".
function parseProjects(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^[-*]\s+`?([\w.-]+)`?(?:\s+\[([^\]]+)\])?(?:\s+[-–—:]\s+(.*))?$/.exec(raw.trim());
    if (m) out.push({ name: m[1], mode: m[2] || null, description: (m[3] || '').trim() });
  }
  return out;
}

// data/secondmates.md: "- <id> <desc> (home: X; scope: Y; projects: Z; added ...)".
function parseSecondmates(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^[-*]\s+`?([\w.-]+)`?\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const rest = m[2];
    const paren = /\(([^()]*)\)\s*$/.exec(rest);
    const fields = {};
    if (paren) {
      for (const part of paren[1].split(';')) {
        const kv = /^\s*([a-z-]+):?\s+(.*)$/i.exec(part);
        if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
      }
    }
    const description = (paren ? rest.slice(0, paren.index) : rest).replace(/^[-–—:]\s*/, '').trim();
    out.push({ id: m[1], description, home: fields.home || null, scope: fields.scope || null, projects: fields.projects || null });
  }
  return out;
}

// First paragraph after the "# Task" heading of a brief, collapsed to one line.
function briefSummary(text, max = 220) {
  const lines = String(text || '').split(/\r?\n/);
  let i = lines.findIndex((l) => /^#\s+task\b/i.test(l.trim()));
  if (i < 0) return null;
  const para = [];
  for (i += 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { if (para.length) break; continue; }
    if (/^#/.test(l)) { if (para.length) break; continue; }
    para.push(l);
  }
  if (!para.length) return null;
  const s = para.join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const DAY_MS = 86400000;
const DEFAULT_STALE_DAYS = 7;

// A crew member is stale when its latest activity is older than staleDays.
// Done crew are finished (waiting for cleanup), so staleness does not apply.
function isStale(state, lastActivity, now, staleDays = DEFAULT_STALE_DAYS) {
  if (state === 'done' || !lastActivity || !(staleDays > 0)) return false;
  return now - lastActivity > staleDays * DAY_MS;
}

function projectName(projectPath) {
  if (!projectPath) return 'unassigned';
  return path.basename(projectPath.replace(/\/+$/, '')) || 'unassigned';
}

function parseTmuxWindows(text) {
  const set = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (l) set.add(l);
  }
  return set;
}

// ---------- file access (read-only) ----------

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}
function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}
// Reads only the tail of large append-only logs.
function readTail(p, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString('utf8');
    if (start > 0) s = s.slice(s.indexOf('\n') + 1);
    return s;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Lists tmux windows read-only. Resolves null when tmux is absent or not running.
function listTmuxWindows(timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      execFile('tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_name}'],
        { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : parseTmuxWindows(stdout)));
    } catch {
      resolve(null);
    }
  });
}

function buildTask(home, id, projectsByKey, tmuxWindows, now, staleDays) {
  const stateDir = path.join(home, 'state');
  const dataDir = path.join(home, 'data');
  const metaPath = path.join(stateDir, id + '.meta');
  const statusPath = path.join(stateDir, id + '.status');
  const turnPath = path.join(stateDir, id + '.turn-ended');
  const meta = parseMeta(readText(metaPath));
  const statusText = readTail(statusPath);
  const entries = parseStatus(statusText);
  const statusMtime = mtimeMs(statusPath);
  const turnEnded = mtimeMs(turnPath);
  const metaMtime = mtimeMs(metaPath);
  const pName = projectName(meta.project);
  const reg = projectsByKey.get(pName.toLowerCase());
  const last = entries.slice(-5).map((e, i, arr) => ({
    ...e,
    // Untimestamped final line: best estimate is the status file mtime.
    approxTs: !e.ts && i === arr.length - 1 && statusMtime ? statusMtime : null,
  }));
  const briefPath = path.join(dataDir, id, 'brief.md');
  const reportPath = path.join(dataDir, id, 'report.md');
  let alive = null;
  if (tmuxWindows && meta.window) alive = tmuxWindows.has(meta.window);
  const state = displayState(entries);
  const lastActivity = Math.max(statusMtime || 0, turnEnded || 0, metaMtime || 0) || null;
  return {
    id,
    kind: meta.kind || 'ship',
    mode: meta.mode || null,
    harness: meta.harness || null,
    model: meta.model || null,
    effort: meta.effort || null,
    window: meta.window || null,
    worktree: meta.worktree || null,
    projectPath: meta.project || null,
    project: reg ? reg.name : pName,
    projectKey: pName.toLowerCase(),
    pr: meta.pr || null,
    prHead: meta.pr_head || null,
    home: meta.home || null,
    state,
    stale: isStale(state, lastActivity, now, staleDays),
    rawState: entries.length ? entries[entries.length - 1].state : null,
    statusCount: entries.length,
    lastStatus: last,
    statusMtime,
    turnEnded,
    lastActivity,
    brief: briefSummary(readText(briefPath)),
    hasReport: exists(reportPath),
    alive,
  };
}

const ID_RE = /^[A-Za-z0-9][\w.-]*$/;

async function buildSnapshot(home, opts = {}) {
  const now = opts.now || Date.now();
  const staleDays = opts.staleDays === undefined ? DEFAULT_STALE_DAYS : opts.staleDays;
  const stateDir = path.join(home, 'state');
  const dataDir = path.join(home, 'data');
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { /* missing state dir */ }
  const ids = names
    .filter((n) => n.endsWith('.meta') && !n.startsWith('.'))
    .map((n) => n.slice(0, -5))
    .filter((id) => ID_RE.test(id))
    .sort();

  const projects = parseProjects(readText(path.join(dataDir, 'projects.md')));
  const projectsByKey = new Map(projects.map((p) => [p.name.toLowerCase(), p]));
  const tmuxWindows = opts.tmux === false ? null : await (opts.listTmux || listTmuxWindows)();

  const tasks = ids.map((id) => buildTask(home, id, projectsByKey, tmuxWindows, now, staleDays));
  const backlog = parseBacklog(readText(path.join(dataDir, 'backlog.md')));
  const smText = readText(path.join(dataDir, 'secondmates.md'));
  const secondmates = parseSecondmates(smText);

  const beat = mtimeMs(path.join(stateDir, '.last-watcher-beat'));
  const counts = {};
  // Stale crew move out of their state's count into "stale", so counts sum to the crew size.
  for (const t of tasks) {
    const k = t.stale ? 'stale' : t.state;
    counts[k] = (counts[k] || 0) + 1;
  }

  return {
    generatedAt: now,
    home,
    staleDays,
    afk: exists(path.join(stateDir, '.afk')),
    watcher: {
      lastBeat: beat,
      ageSec: beat ? Math.max(0, Math.round((now - beat) / 1000)) : null,
      healthy: beat ? now - beat < 120000 : false,
    },
    tmux: tmuxWindows ? { available: true, windows: tmuxWindows.size } : { available: false },
    counts,
    tasks,
    projects,
    secondmates: { registry: secondmates, registryPresent: smText !== null },
    backlog: {
      present: backlog.captain.length + backlog.inFlight.length + backlog.queued.length + backlog.done.length > 0,
      captain: backlog.captain,
      inFlight: backlog.inFlight,
      queued: backlog.queued,
      done: backlog.done.slice(0, 15),
    },
  };
}

// Path of a scout report for /api/report, or null if the id is unsafe or absent.
function reportPath(home, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const p = path.join(home, 'data', id, 'report.md');
  return exists(p) ? p : null;
}

module.exports = {
  STATES,
  DEFAULT_STALE_DAYS,
  isStale,
  parseMeta,
  parseStatus,
  displayState,
  parseTags,
  parseBacklog,
  parseProjects,
  parseSecondmates,
  briefSummary,
  projectName,
  parseTmuxWindows,
  buildSnapshot,
  reportPath,
  readText,
};
