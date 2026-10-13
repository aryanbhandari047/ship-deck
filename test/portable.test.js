'use strict';
// Portability and plain language: home auto-detection against fixture homes, the
// Claude memory dir derived from the home, the captain's name from git config files,
// task titles, the label/summary mapping, port fallback, the first-run server and
// start.sh. Temp dirs and fabricated data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const homes = require('../lib/home');
const fleet = require('../lib/fleet');
const labels = require('../public/labels');
const { createServer, parseArgs, listen } = require('../server');

const FIX = path.join(__dirname, 'fixtures');
const ROOT = path.join(__dirname, '..');

function tempDir(t, prefix = 'ship-deck-portable-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A copy of the fixture fleet, made to look like a firstmate home when marked.
function fixtureHome(dir, { marked = true } = {}) {
  fs.cpSync(path.join(FIX, 'home'), dir, { recursive: true });
  if (marked) {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Sample firstmate home\n');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'fm-spawn.sh'), '#!/bin/sh\nexit 0\n');
  }
  return dir;
}

// ---------- home detection ----------

test('looksLikeHome needs AGENTS.md, bin/fm-spawn.sh and state/', (t) => {
  const base = tempDir(t);
  assert.equal(homes.looksLikeHome(fixtureHome(path.join(base, 'plain'), { marked: false })), false, 'the bare fixture fleet is not a home');
  const home = fixtureHome(path.join(base, 'marked'));
  assert.equal(homes.looksLikeHome(home), true);
  fs.rmSync(path.join(home, 'state'), { recursive: true });
  assert.equal(homes.looksLikeHome(home), false, 'no state/');
  assert.equal(homes.looksLikeHome(null), false);
});

test('detectHome: --home, then FM_HOME, then the cwd, then ~/firstmate, else first run', (t) => {
  const base = tempDir(t);
  const user = path.join(base, 'user');
  fs.mkdirSync(user);
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const cwdHome = fixtureHome(path.join(base, 'cwd-home'));

  const none = homes.detectHome({ env: {}, cwd: elsewhere, homedir: user });
  assert.equal(none.home, null, 'nothing found: first-run screen');
  assert.deepEqual(none.checked, [elsewhere, path.join(user, 'firstmate')]);

  const def = fixtureHome(path.join(user, 'firstmate'));
  assert.deepEqual(homes.detectHome({ env: {}, cwd: elsewhere, homedir: user }), { home: def, source: 'default', checked: [elsewhere, def] });
  assert.equal(homes.detectHome({ env: {}, cwd: cwdHome, homedir: user }).source, 'cwd', 'the cwd beats ~/firstmate');
  assert.equal(homes.detectHome({ env: {}, cwd: cwdHome, homedir: user }).home, cwdHome);
  assert.deepEqual(homes.detectHome({ env: { FM_HOME: elsewhere }, cwd: cwdHome, homedir: user }), { home: elsewhere, source: 'env', checked: [] });
  assert.equal(homes.detectHome({ flag: 'rel/dir', env: { FM_HOME: elsewhere }, cwd: cwdHome, homedir: user }).home, path.resolve('rel/dir'), '--home wins and resolves');
  assert.equal(homes.detectHome({ env: { FM_HOME: '' }, cwd: elsewhere, homedir: user }).source, 'default', 'an empty FM_HOME is ignored');
});

test('parseArgs auto-detects the home and derives the memory dir from it', (t) => {
  const base = tempDir(t);
  const home = fixtureHome(path.join(base, 'fleet_home'));
  const claude = path.join(base, 'claude');
  const o = parseArgs(['--claude-dir', claude, '--no-open'], { env: {}, cwd: home });
  assert.equal(o.home, home);
  assert.equal(o.homeSource, 'cwd');
  assert.equal(o.open, false);
  assert.equal(o.memoryDir, path.join(claude, 'projects', home.replace(/[/.]/g, '-'), 'memory'));
  assert.equal(o.captainName, undefined, 'no flag: git config decides');
  assert.equal(parseArgs(['--captain-name', 'Sample Captain'], { env: {}, cwd: home }).captainName, 'Sample Captain');
  assert.equal(parseArgs(['--memory-dir', 'mem'], { env: {}, cwd: home }).memoryDir, path.resolve('mem'), '--memory-dir wins');
  assert.equal(parseArgs([], { env: { SHIP_DECK_NO_OPEN: '1' }, cwd: home }).open, false);
  assert.equal(parseArgs([], { env: {}, cwd: home }).open, true, 'opens the browser by default');
  const lost = parseArgs([], { env: {}, cwd: base });
  if (!homes.looksLikeHome(path.join(os.homedir(), 'firstmate'))) {
    assert.equal(lost.home, null);
    assert.equal(lost.memoryDir, undefined, 'no home, no memory dir');
  }
});

// ---------- Claude dirs derived from the home ----------

test('memory dir: <claude>/projects/<encoded home>/memory, preferring an encoding that exists', (t) => {
  const claude = tempDir(t);
  const home = '/srv/fleet_home/first.mate';
  assert.equal(homes.memoryDirFor(claude, home), path.join(claude, 'projects', '-srv-fleet_home-first-mate', 'memory'), 'documented form when none exists');
  fs.mkdirSync(path.join(claude, 'projects', '-srv-fleet-home-first-mate'), { recursive: true });
  assert.equal(homes.memoryDirFor(claude, home), path.join(claude, 'projects', '-srv-fleet-home-first-mate', 'memory'), 'the broader form when only it exists');
  fs.mkdirSync(path.join(claude, 'projects', '-srv-fleet_home-first-mate'), { recursive: true });
  assert.equal(homes.claudeProjectDir(claude, home), path.join(claude, 'projects', '-srv-fleet_home-first-mate'));
});

test('the library reads first mate memory from the derived dir', async (t) => {
  const base = tempDir(t);
  const home = fixtureHome(path.join(base, 'home'));
  const claudeDir = path.join(base, 'claude');
  const mem = homes.memoryDirFor(claudeDir, home);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# Sample memory index\n');
  const server = createServer({ home, tmux: false, ordersDir: path.join(base, 'orders'), claudeDir, captainName: null, exec: async () => ({ code: 1 }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base_ = `http://127.0.0.1:${server.address().port}`;
  const lib = await (await fetch(base_ + '/api/library')).json();
  const m = lib.entries.find((e) => e.key === 'memory:MEMORY.md');
  assert.equal(m.exists, true);
  assert.equal(m.path, path.join(mem, 'MEMORY.md'));
});

// ---------- captain name ----------

test('captain name comes from the home repo config, a worktree common dir, or the global config', (t) => {
  const base = tempDir(t);
  const user = path.join(base, 'user');
  fs.mkdirSync(user);
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.git'), { recursive: true });
  const opts = { homedir: user, env: {} };
  assert.equal(homes.captainName(home, opts), null, 'no config anywhere');

  fs.writeFileSync(path.join(user, '.gitconfig'), '[user]\n\temail = sample@example.com\n\tname = Global Sample\n');
  assert.equal(homes.captainName(home, opts), 'Global Sample');
  fs.writeFileSync(path.join(home, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\tname = not-this\n[user]\n\tname = "Sample Captain" # local\n');
  assert.equal(homes.captainName(home, opts), 'Sample Captain', 'repo config beats global, quotes and comments stripped');

  // A worktree home: .git is a file pointing at a git dir whose commondir holds the config.
  const wt = path.join(base, 'wt');
  fs.mkdirSync(wt);
  fs.mkdirSync(path.join(home, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(home, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(home, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(homes.captainName(wt, opts), 'Sample Captain');

  fs.rmSync(path.join(user, '.gitconfig'));
  fs.mkdirSync(path.join(user, 'xdg', 'git'), { recursive: true });
  fs.writeFileSync(path.join(user, 'xdg', 'git', 'config'), '[user]\nname=Xdg Sample\n');
  assert.equal(homes.captainName(path.join(base, 'not-a-repo'), { homedir: user, env: { XDG_CONFIG_HOME: path.join(user, 'xdg') } }), 'Xdg Sample');
  assert.equal(homes.gitUserName('[userx]\nname = no\n'), null);
});

// ---------- titles ----------

test('task title: the queue entry, else the brief, else the id', () => {
  assert.equal(fleet.briefTitle('# Fix the harbor lights\n\nmore'), 'Fix the harbor lights', 'a leading title heading');
  assert.equal(fleet.briefTitle('You are a crewmate.\n\n# Task\nMake the **tide chart** use [UTC](https://example.com).\nSecond line.\n\n# Rules\n'), 'Make the tide chart use UTC.', 'first line under # Task');
  assert.equal(fleet.briefTitle('# Task\n\n'), null);
  assert.equal(fleet.briefTitle('Just a line\n'), 'Just a line');
  assert.equal(fleet.briefTitle('# Task\n' + 'x'.repeat(200)).length, 90);
});

test('snapshot tasks carry a title', async (t) => {
  const home = fixtureHome(tempDir(t), { marked: false });
  fs.writeFileSync(path.join(home, 'data', 'beta-scout', 'brief.md'), 'You are a crewmate.\n\n# Task\nDiagnose the tide drift\n');
  fs.rmSync(path.join(home, 'data', 'backlog.md'));
  const snap = await fleet.buildSnapshot(home, { tmux: false });
  const by = Object.fromEntries(snap.tasks.map((x) => [x.id, x.title]));
  assert.equal(by['beta-scout'], 'Diagnose the tide drift', 'from the brief');
  assert.equal(by['delta-block'], 'delta-block', 'falls back to the id');
  const withQueue = await fleet.buildSnapshot(fixtureHome(tempDir(t), { marked: false }), { tmux: false });
  assert.equal(withQueue.tasks.find((x) => x.id === 'alpha-fix').title, 'Fix the lighthouse crash', 'from the queue entry');
});

// ---------- labels ----------

test('plain-language labels and the one-sentence summary', () => {
  const t = (state, note, extra) => ({ state, lastStatus: note === undefined ? [] : [{ state, note }], ...extra });
  assert.equal(labels.summary(t('working', 'fix implemented, running the suite')), 'Working');
  assert.equal(labels.summary(t('needs-decision', 'the legacy endpoint still has callers. Options: (A) keep')), 'Waiting on your call');
  assert.equal(labels.summary(t('blocked', 'the staging database is unreachable; retried 3 times')), 'Blocked: the staging database is unreachable');
  assert.equal(labels.summary(t('blocked')), 'Blocked');
  assert.equal(labels.summary(t('paused', 'waiting for the upstream release - expected Friday')), 'Paused: waiting for the upstream release');
  assert.equal(labels.summary(t('done', 'PR merged')), 'Done - ready for cleanup');
  assert.equal(labels.summary(t('failed', 'out of disk')), 'Failed');
  assert.equal(labels.summary(t('unknown')), 'Starting up');
  const now = Date.UTC(2026, 0, 20);
  assert.equal(labels.summary(t('working', 'x', { stale: true, lastActivity: now - 9 * 86400000 }), now), 'Quiet for 9 days · Working');
  assert.equal(labels.quietText(now - 86400000 * 1.5, now), 'Quiet for 1 day');

  assert.equal(labels.firstClause('first clause, second clause'), 'first clause');
  assert.equal(labels.firstClause('a: b'), 'a');
  assert.equal(labels.firstClause('v1.2 is out (tagged)'), 'v1.2 is out', 'a dot inside a word does not cut');
  assert.equal(labels.firstClause('x'.repeat(100)).length, 60);

  assert.equal(labels.kindLabel('cleanup-done'), 'Clean up finished workers');
  assert.equal(labels.kindLabel('backlog-start'), 'Start from queue');
  assert.equal(labels.kindLabel('mystery'), 'Message');
  assert.equal(labels.stateLabel('needs-decision'), 'needs you');
  assert.equal(labels.stateLabel('stale'), 'quiet');
  assert.equal(labels.messageStatus('pending'), 'waiting');
  assert.equal(labels.messageStatus('acknowledged'), 'seen');
});

// ---------- port fallback ----------

test('listen falls back to the next free port', async (t) => {
  const busy = http.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const taken = busy.address().port;
  const srv = http.createServer();
  t.after(() => srv.close());
  const got = await listen(srv, taken);
  assert.ok(got > taken && got < taken + 20, `got ${got} after ${taken}`);
  const solo = http.createServer();
  await assert.rejects(listen(solo, taken, { tries: 1 }), /EADDRINUSE/, 'no fallback past the range');
});

// ---------- servers ----------

test('no home: the first-run server explains itself and refuses the fleet APIs', async (t) => {
  const server = createServer({ home: null, homeChecked: ['/tmp/sample-cwd', '/tmp/sample-user/firstmate'], ordersDir: tempDir(t), claudeDir: tempDir(t) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(base + '/api/fleet')).json(), { firstRun: true, checked: ['/tmp/sample-cwd', '/tmp/sample-user/firstmate'] });
  assert.equal((await (await fetch(base + '/api/health')).json()).app, 'ship-deck');
  assert.equal((await fetch(base + '/api/library')).status, 503);
  const post = await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: '{"kind":"chat","text":"hi"}' });
  assert.equal(post.status, 503);
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /id="first-run"/);
  assert.match(page, /labels\.js/);
  const status = await new Promise((r) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { Host: 'evil.example' } }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(status, 421, 'Host guard still applies');
});

test('/api/fleet carries the captain name and task titles', async (t) => {
  const home = fixtureHome(tempDir(t), { marked: false });
  const server = createServer({ home, tmux: false, ordersDir: tempDir(t), claudeDir: tempDir(t), memoryDir: null, captainName: 'Sample Captain', exec: async () => ({ code: 1 }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const snap = await (await fetch(`http://127.0.0.1:${server.address().port}/api/fleet`)).json();
  assert.deepEqual(snap.captain, { name: 'Sample Captain' });
  assert.equal(snap.tasks.find((x) => x.id === 'gamma-decision').title, 'Migrate beacon endpoints');
});

test('start.sh starts the server on the next port when another app holds it', async (t) => {
  // Below the OS ephemeral range, so other suites' servers (port 0) never sit in the scanned window.
  const busy = http.createServer((q, s) => s.end('another app'));
  busy.on('error', () => busy.listen(20000 + Math.floor(Math.random() * 9000), '127.0.0.1'));
  await new Promise((r) => { busy.once('listening', r); busy.listen(20000 + Math.floor(Math.random() * 9000), '127.0.0.1'); });
  t.after(() => busy.close());
  const port = busy.address().port;
  const user = tempDir(t);
  const out = await new Promise((resolve, reject) => {
    // Async so the busy server keeps answering while start.sh probes it.
    require('node:child_process').execFile('/bin/sh', [path.join(ROOT, 'bin/start.sh'), '--port', String(port), '--no-open', '--no-tmux'],
      { env: { PATH: process.env.PATH, HOME: user, SHIP_DECK_NO_OPEN: '1' }, cwd: user, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  const pid = Number((/pid (\d+)/.exec(out) || [])[1]);
  if (pid) t.after(() => { try { process.kill(pid); } catch { /* gone */ } });
  const m = /started at http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
  assert.ok(m, out);
  assert.ok(Number(m[1]) > port, 'moved to a free port');
  const health = await (await fetch(`http://127.0.0.1:${m[1]}/api/health`)).json();
  assert.deepEqual(health, { app: 'ship-deck', ok: true, home: null }, 'no home under the temp HOME: first run');
  assert.match(execFileSync('/bin/sh', [path.join(ROOT, 'bin/start.sh'), '--port', String(port), '--no-open'], { env: { PATH: process.env.PATH, HOME: user, SHIP_DECK_NO_OPEN: '1' }, cwd: user, encoding: 'utf8' }),
    new RegExp(`already running at http://127.0.0.1:${m[1]}/`), 'found in the port range');
});
