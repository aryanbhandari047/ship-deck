'use strict';
// The captain's actions on a crew member. The only commands Ship Deck runs:
//   tmux capture-pane -p -t <window-from-meta> -S -80   (read-only pane peek)
//   FM_HOME=<home> <home>/bin/fm-send.sh <window-from-meta> <message>
// (plus `tmux list-windows` in lib/fleet.js). Always execFile with a fixed argv;
// the client only ever names a crew id, and the window comes from its meta.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseMeta, DATA_FILE_RE } = require('./fleet');
const { TASK_ID_RE, cleanText, MAX_TEXT } = require('./orders');

// tmux session:window target as firstmate records it, e.g. firstmate:fm-<id>.
// No leading '-' (never an option), no shell or tmux-special characters.
const WINDOW_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const MAX_DATA_FILE = 512 * 1024;
const PEEK_LINES = 80;

function validId(id) {
  return typeof id === 'string' && id.length <= 128 && TASK_ID_RE.test(id);
}

// The tmux window recorded in state/<id>.meta, or null when the id is invalid,
// has no meta, or the recorded window is not a well-formed target.
function lookupWindow(home, id) {
  if (!validId(id)) return null;
  let text;
  try { text = fs.readFileSync(path.join(home, 'state', id + '.meta'), 'utf8'); } catch { return null; }
  const w = parseMeta(text).window;
  return w && WINDOW_RE.test(w) ? w : null;
}

function defaultExec(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
  });
}

class ActionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Last PEEK_LINES lines of the crew member's tmux pane.
async function peekPane(home, id, exec = defaultExec) {
  if (!validId(id)) throw new ActionError(400, 'invalid id');
  const win = lookupWindow(home, id);
  if (!win) throw new ActionError(404, 'this worker has no terminal window');
  const r = await exec('tmux', ['capture-pane', '-p', '-t', win, '-S', '-' + PEEK_LINES], { timeout: 3000 });
  if (r.code !== 0) throw new ActionError(502, (r.stderr || r.error || 'capture-pane failed').trim());
  const lines = r.stdout.replace(/\s+$/, '').split('\n');
  return { window: win, text: lines.slice(-PEEK_LINES).join('\n') };
}

// One line, at most MAX_TEXT chars, never something fm-send would read as a flag.
function cleanMessage(msg) {
  const m = cleanText(msg);
  if (!m) throw new ActionError(400, 'message is empty');
  if (m.length > MAX_TEXT) throw new ActionError(400, `message is longer than ${MAX_TEXT} characters`);
  if (m.startsWith('--')) throw new ActionError(400, 'message may not start with "--"');
  return m;
}

async function sendMessage(home, id, message, exec = defaultExec) {
  if (!validId(id)) throw new ActionError(400, 'invalid id');
  const msg = cleanMessage(message);
  const win = lookupWindow(home, id);
  if (!win) throw new ActionError(404, 'this worker has no terminal window');
  const r = await exec(path.join(home, 'bin', 'fm-send.sh'), [win, msg], {
    timeout: 30000,
    env: { ...process.env, FM_HOME: home },
  });
  const out = (r.stderr || r.stdout || r.error || '').trim().split('\n').slice(-6).join('\n');
  return { ok: r.code === 0, window: win, code: r.code, output: out };
}

// Text of data/<id>/<name>, refusing anything that resolves outside that dir.
function readDataFile(home, id, name) {
  if (!validId(id) || typeof name !== 'string' || !DATA_FILE_RE.test(name)) throw new ActionError(400, 'invalid path');
  const dir = path.join(home, 'data', id);
  let real, realDir;
  try { realDir = fs.realpathSync(dir); real = fs.realpathSync(path.join(dir, name)); } catch { throw new ActionError(404, 'not found'); }
  if (path.dirname(real) !== realDir) throw new ActionError(403, 'forbidden');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new ActionError(404, 'not found');
  const fd = fs.openSync(real, 'r');
  try {
    const len = Math.min(st.size, MAX_DATA_FILE);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { text: buf.toString('utf8'), truncated: st.size > MAX_DATA_FILE, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  WINDOW_RE,
  PEEK_LINES,
  ActionError,
  validId,
  lookupWindow,
  peekPane,
  cleanMessage,
  sendMessage,
  readDataFile,
  defaultExec,
};
