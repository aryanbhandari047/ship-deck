'use strict';
// "Open in terminal": attaches the captain's own terminal to a worker's live tmux window through
// a throwaway grouped session (other clients keep their view; Ctrl-b d removes only that session,
// never the worker). Commands, all execFile with a fixed argv:
//   tmux list-windows -a -F ...                          (the window must exist right now)
//   osascript -e 'application id "<iTerm>" is running'   (macOS: prefer a running iTerm)
//   osascript -e <constant script> <attach command>      (macOS: the command is argv, not script)
// The client names only a crew id; session and window come from its meta and tmux.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMeta } = require('./fleet');
const { WINDOW_RE, ActionError, validId, defaultExec } = require('./actions');

const ITERM = 'com.googlecode.iterm2';
const TERMINAL = 'com.apple.Terminal';
const WINDOW_ID_RE = /^@\d+$/;
const BACKEND_RE = /^[a-z][a-z0-9-]{0,19}$/;
const HINT = 'paste in a terminal; detach with Ctrl-b d';

// Constant scripts: the attach command arrives as `item 1 of argv`, so nothing is escaped into code.
const SCRIPTS = {
  iterm: [
    'on run argv',
    `tell application id "${ITERM}"`,
    'activate',
    'set w to (create window with default profile)',
    'tell current session of w to write text (item 1 of argv)',
    'end tell',
    'end run',
  ],
  terminal: [
    'on run argv',
    `tell application id "${TERMINAL}"`,
    'do script (item 1 of argv)',
    'activate',
    'end tell',
    'end run',
  ],
};

// { id, session, window, windowId } for a tmux-backed worker whose window exists now.
async function resolveTarget(home, id, exec = defaultExec) {
  if (!validId(id)) throw new ActionError(400, 'invalid id');
  let text;
  try { text = fs.readFileSync(path.join(home, 'state', id + '.meta'), 'utf8'); } catch { throw new ActionError(404, 'unknown worker'); }
  const meta = parseMeta(text);
  if (meta.backend && meta.backend !== 'tmux') {
    throw new ActionError(409, `runs on ${BACKEND_RE.test(meta.backend) ? meta.backend : 'another backend'}, not tmux`);
  }
  const win = meta.window;
  if (!win || !WINDOW_RE.test(win)) throw new ActionError(404, 'this worker has no tmux window');
  const r = await exec('tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_name}\t#{window_id}'], { timeout: 3000 });
  if (r.code !== 0) throw new ActionError(503, 'tmux is not running');
  const hit = r.stdout.split('\n').map((l) => l.split('\t')).find((p) => p[0] === win && WINDOW_ID_RE.test(p[1] || ''));
  if (!hit) throw new ActionError(409, 'its tmux window is gone');
  return { id, session: win.slice(0, win.indexOf(':')), window: win, windowId: hit[1] };
}

const sessionName = (id, rand) => `deck-${id.slice(0, 40)}-${rand}`;

// tmux argv (after `tmux`): a new session grouped with the worker's, gone once unattached,
// showing the worker's window. `=` makes the group target exact (tmux 3.7 refuses it on the rest).
function attachArgv(target, name) {
  return ['new-session', '-t', '=' + target.session, '-s', name,
    ';', 'set-option', '-t', name, 'destroy-unattached', 'on',
    ';', 'select-window', '-t', `${name}:${target.windowId}`];
}

// POSIX/fish-safe word: bare only when it has no special characters (zsh expands a leading `=`).
function shQuote(s) {
  return /^[A-Za-z0-9_@%+:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function shellCommand(argv) {
  return ['tmux', ...argv].map((a) => (a === ';' ? '\\;' : shQuote(a))).join(' ');
}

// osascript argv for app ('iterm' | 'terminal'); the command is passed to the script as data.
function osascriptArgv(app, command) {
  const lines = SCRIPTS[app];
  if (!lines) throw new Error('unknown terminal app');
  if (typeof command !== 'string' || /[\0-\x1f\x7f]/.test(command)) throw new Error('bad command');
  return [...lines.flatMap((l) => ['-e', l]), command];
}

// iTerm when it is installed and running, else Terminal.
async function pickApp(exec) {
  const r = await exec('osascript', ['-e', `application id "${ITERM}" is running`], { timeout: 5000 });
  return r.code === 0 && r.stdout.trim() === 'true' ? 'iterm' : 'terminal';
}

// The attach command for id; with open (macOS only) also launches it in a terminal window.
// Result: { ok, command, hint, opened, app?, error? }; never throws for a failed launch.
async function attach(home, id, { open = false, exec = defaultExec, platform = process.platform, rand } = {}) {
  const target = await resolveTarget(home, id, exec);
  const command = shellCommand(attachArgv(target, sessionName(id, rand || crypto.randomBytes(3).toString('hex'))));
  const out = { ok: true, window: target.window, command, hint: HINT, opened: false };
  if (!open) return out;
  if (platform !== 'darwin') return { ...out, error: 'no terminal to open here' };
  const app = await pickApp(exec);
  const r = await exec('osascript', osascriptArgv(app, command), { timeout: 15000 });
  if (r.code !== 0) return { ...out, app, error: (r.stderr || r.error || 'osascript failed').trim().split('\n').slice(-2).join(' ') };
  return { ...out, app, opened: true };
}

module.exports = { resolveTarget, attachArgv, shellCommand, shQuote, osascriptArgv, sessionName, attach, SCRIPTS, HINT };
