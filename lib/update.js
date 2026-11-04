'use strict';
// "Update available" for an installed deck (<app>/.ship-deck-install from bin/install.sh), and the
// Update button. Checks on start and every few hours with read-only git in the source checkout:
// rev-parse, ls-remote (the only network; failures just mean "no news"), cat-file, merge-base.
// A click runs bin/update.sh detached (it restarts this server); never without a click.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const LOG_TAIL = 2000;

function readInstall(appDir) {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(appDir, '.ship-deck-install'), 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return out;
  } catch { return null; }
}

// The checkout an install updates from: its source folder, else <deck>/src (curl installs).
function sourceDir(install, appDir) {
  const s = install && install.source;
  if (s && path.isAbsolute(s) && fs.existsSync(path.join(s, '.git'))) return s;
  const own = path.join(path.dirname(appDir), 'src');
  return fs.existsSync(path.join(own, '.git')) ? own : null;
}

// Resolves stdout (trimmed), or null on any failure.
function defaultGit(args) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    } catch { resolve(null); }
  });
}

async function check({ appDir, git = defaultGit }) {
  const install = readInstall(appDir);
  const current = install && /^[0-9a-f]{4,40}$/.test(install.revision || '') ? install.revision : null;
  const src = sourceDir(install, appDir);
  if (!current || !src) return { supported: false };
  const upstream = await git(['-C', src, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const slash = upstream ? upstream.indexOf('/') : -1;
  if (slash <= 0) return { supported: false };
  const remote = upstream.slice(0, slash);
  const branch = upstream.slice(slash + 1);
  const line = await git(['-C', src, 'ls-remote', '--quiet', remote, 'refs/heads/' + branch]);
  const latest = line ? line.split(/\s+/)[0] : '';
  const base = { supported: true, available: false, current: current.slice(0, 7) };
  if (!/^[0-9a-f]{40}$/.test(latest)) return { ...base, offline: true };
  if (latest.startsWith(current)) return { ...base, latest: latest.slice(0, 7) };
  // Ours is newer (e.g. installed from a local branch ahead of its remote): nothing to get.
  const known = (await git(['-C', src, 'cat-file', '-e', latest + '^{commit}'])) !== null;
  if (known && (await git(['-C', src, 'merge-base', '--is-ancestor', latest, current])) !== null) return { ...base, latest: latest.slice(0, 7) };
  return { ...base, available: true, latest: latest.slice(0, 7) };
}

// One per server. run() spawns bin/update.sh; on success it stops this process and starts the new one.
function createUpdater({ appDir, deckDir, home = null, git = defaultGit, spawnFn = spawn, now = Date.now } = {}) {
  const state = { supported: false, available: false, checkedAt: null, running: false, result: null };
  const timers = [];
  const log = path.join(deckDir, 'update.log');
  async function refresh() {
    try { Object.assign(state, await check({ appDir, git }), { checkedAt: now() }); } catch { /* no news */ }
    return view();
  }
  function view() {
    const { supported, available, current, latest, checkedAt, running, result } = state;
    return { supported, available, current: current || null, latest: latest || null, checkedAt, running, result };
  }
  function run() {
    if (state.running) return { ok: true, running: true };
    if (!state.supported) return { ok: false, error: 'this deck was not installed with the installer, so it cannot update itself' };
    let fd;
    try {
      fs.mkdirSync(deckDir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(log, 'w', 0o600);
    } catch (e) { return { ok: false, error: 'cannot write ' + log + ': ' + e.message }; }
    let child;
    try {
      child = spawnFn('/bin/sh', [path.join(appDir, 'bin', 'update.sh')], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ...(home ? { FM_HOME: home } : {}), SHIP_DECK_NO_OPEN: '1' },
      });
    } catch (e) {
      fs.closeSync(fd);
      return { ok: false, error: e.message };
    }
    fs.closeSync(fd);
    state.running = true;
    state.result = null;
    // Still here afterwards: nothing to update, or it stopped with a reason (local changes, offline...).
    child.on('exit', (code) => {
      state.running = false;
      let text = '';
      try { text = fs.readFileSync(log, 'utf8').slice(-LOG_TAIL); } catch { /* none */ }
      const lines = text.trim().split('\n').filter(Boolean);
      state.result = { ok: code === 0, message: (code === 0 ? lines.slice(-1) : lines.slice(-2)).join('\n') };
      refresh();
    });
    child.on('error', (e) => { state.running = false; state.result = { ok: false, message: e.message }; });
    if (child.unref) child.unref();
    return { ok: true, running: true };
  }
  function start() {
    const first = setTimeout(refresh, FIRST_CHECK_MS);
    const every = setInterval(refresh, CHECK_EVERY_MS);
    for (const t of [first, every]) { if (t.unref) t.unref(); timers.push(t); }
  }
  function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } }
  return { refresh, view, run, start, stop };
}

module.exports = { readInstall, sourceDir, check, createUpdater, CHECK_EVERY_MS };
