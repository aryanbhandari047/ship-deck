'use strict';
// "Open in terminal" (lib/terminal.js, POST /api/attach, labels.attachState). The executor is
// injected: nothing here runs tmux, osascript or opens a window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const terminal = require('../lib/terminal');
const labels = require('../public/labels');
const share = require('../lib/share');
const { createServer } = require('../server');

const FIX = path.join(__dirname, 'fixtures', 'home');
const LIST = 'fleet:fm-alpha-fix\t@7\nfleet:fm-beta-scout\t@8\nother:main\t@1\n';

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tempHome(t) {
  const dir = tmp(t, 'ship-deck-term-');
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}
// Answers tmux list-windows with `list` and osascript with `osa`; records every call.
function fakeExec({ list = LIST, listCode = 0, osa = () => ({ code: 0, stdout: '', stderr: '' }) } = {}) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'tmux') return { code: listCode, stdout: listCode ? '' : list, stderr: listCode ? 'no server running' : '' };
    if (file === 'osascript') return osa(args);
    return { code: 127, stdout: '', stderr: 'unexpected' };
  };
  exec.calls = calls;
  return exec;
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));

// ---------- target resolution ----------

test('resolveTarget: window from the meta, checked against tmux list-windows', async (t) => {
  const home = tempHome(t);
  const exec = fakeExec();
  assert.deepEqual(await terminal.resolveTarget(home, 'alpha-fix', exec), { id: 'alpha-fix', session: 'fleet', window: 'fleet:fm-alpha-fix', windowId: '@7' });
  assert.deepEqual(exec.calls.map((c) => [c.file, ...c.args]), [['tmux', 'list-windows', '-a', '-F', '#{session_name}:#{window_name}\t#{window_id}']]);
});

test('resolveTarget refuses bad ids, missing meta, missing or malformed window, other backends', async (t) => {
  const home = tempHome(t);
  const exec = fakeExec();
  for (const bad of ['../alpha-fix', 'Alpha', '', 'a b', 'a;b', '-x', null, 7, 'x'.repeat(200)]) await rejects(terminal.resolveTarget(home, bad, exec), 400);
  await rejects(terminal.resolveTarget(home, 'ghost', exec), 404, /unknown worker/);
  fs.writeFileSync(path.join(home, 'state', 'no-window.meta'), 'kind=ship\n');
  await rejects(terminal.resolveTarget(home, 'no-window', exec), 404, /no tmux window/);
  for (const w of ['fleet:fm-x;kill-server', '-t:x', 'fleet', "fleet:fm-'x", 'fleet:$(id)', 'a:b:c']) {
    fs.writeFileSync(path.join(home, 'state', 'evil-win.meta'), `window=${w}\n`);
    await rejects(terminal.resolveTarget(home, 'evil-win', exec), 404, /no tmux window/);
  }
  fs.writeFileSync(path.join(home, 'state', 'herdr-one.meta'), 'window=fleet:fm-alpha-fix\nbackend=herdr\n');
  await rejects(terminal.resolveTarget(home, 'herdr-one', exec), 409, /runs on herdr/);
  fs.writeFileSync(path.join(home, 'state', 'odd-backend.meta'), 'window=fleet:fm-alpha-fix\nbackend=<script>\n');
  await rejects(terminal.resolveTarget(home, 'odd-backend', exec), 409, /another backend/);
  assert.equal(exec.calls.length, 0, 'tmux is only asked about a valid tmux window');
  fs.writeFileSync(path.join(home, 'state', 'tmux-one.meta'), 'window=fleet:fm-alpha-fix\nbackend=tmux\n');
  assert.equal((await terminal.resolveTarget(home, 'tmux-one', exec)).windowId, '@7');
});

test('resolveTarget: window gone, tmux not running, odd list-windows output', async (t) => {
  const home = tempHome(t);
  await rejects(terminal.resolveTarget(home, 'delta-block', fakeExec()), 409, /window is gone/);
  await rejects(terminal.resolveTarget(home, 'alpha-fix', fakeExec({ listCode: 1 })), 503, /not running/);
  // a lookalike name or a malformed id never matches
  await rejects(terminal.resolveTarget(home, 'alpha-fix', fakeExec({ list: 'fleet:fm-alpha-fix-2\t@3\nfleet:fm-alpha-fix\t7\n' })), 409);
});

// ---------- command and AppleScript ----------

test('attach command: grouped throwaway session, exact group target, window by id', () => {
  const argv = terminal.attachArgv({ session: 'fleet', windowId: '@7' }, 'deck-alpha-fix-abc123');
  assert.deepEqual(argv, ['new-session', '-t', '=fleet', '-s', 'deck-alpha-fix-abc123',
    ';', 'set-option', '-t', 'deck-alpha-fix-abc123', 'destroy-unattached', 'on',
    ';', 'select-window', '-t', 'deck-alpha-fix-abc123:@7']);
  assert.equal(terminal.shellCommand(argv),
    "tmux new-session -t '=fleet' -s deck-alpha-fix-abc123 \\; set-option -t deck-alpha-fix-abc123 destroy-unattached on \\; select-window -t deck-alpha-fix-abc123:@7");
  assert.ok(!argv.some((a) => /kill|rename|send-keys|respawn/.test(a)), 'never kills, renames or types into the worker');
  assert.equal(terminal.sessionName('x'.repeat(60), 'ff00aa'), `deck-${'x'.repeat(40)}-ff00aa`);
});

test('shQuote leaves no shell syntax unquoted', () => {
  for (const s of ['=fleet', "a'b", 'a b', '$(id)', '`id`', 'a;b', 'a|b', '~x', '*', 'a\\b', '!x', '#x']) {
    const q = terminal.shQuote(s);
    assert.ok(q.startsWith("'") && q.endsWith("'"), `${s} -> ${q}`);
  }
  assert.equal(terminal.shQuote("a'b"), "'a'\\''b'");
  assert.equal(terminal.shQuote('fleet:@7'), 'fleet:@7');
});

test('osascript: constant script, the command passed as argv data', () => {
  const evil = 'tmux x" & do shell script "rm -rf ~" & "';
  for (const app of ['iterm', 'terminal']) {
    const argv = terminal.osascriptArgv(app, evil);
    assert.equal(argv[argv.length - 1], evil, 'command is the last argv item, verbatim');
    const script = argv.slice(0, -1);
    assert.ok(script.every((a, i) => (i % 2 === 0 ? a === '-e' : terminal.SCRIPTS[app].includes(a))), 'only the fixed script lines');
    assert.ok(script.some((l) => l.includes('item 1 of argv')));
    assert.ok(!script.join('\n').includes('rm -rf'));
  }
  assert.throws(() => terminal.osascriptArgv('iterm', 'tmux\nrm -rf ~'), /bad command/);
  assert.throws(() => terminal.osascriptArgv('xterm', 'tmux'), /unknown terminal/);
});

test('attach: copy only, Linux, iTerm running, Terminal fallback, launch failure', async (t) => {
  const home = tempHome(t);
  let exec = fakeExec();
  let r = await terminal.attach(home, 'alpha-fix', { exec, platform: 'darwin', rand: 'abc123' });
  assert.equal(r.opened, false);
  assert.match(r.command, /^tmux new-session -t '=fleet' -s deck-alpha-fix-abc123 /);
  assert.equal(r.hint, 'paste in a terminal; detach with Ctrl-b d');
  assert.ok(!exec.calls.some((c) => c.file === 'osascript'), 'copy never launches');

  exec = fakeExec();
  r = await terminal.attach(home, 'alpha-fix', { open: true, exec, platform: 'linux' });
  assert.equal(r.opened, false);
  assert.match(r.error, /no terminal/);
  assert.ok(!exec.calls.some((c) => c.file === 'osascript'));

  exec = fakeExec({ osa: (args) => ({ code: 0, stdout: args.length === 2 ? 'true\n' : '', stderr: '' }) });
  r = await terminal.attach(home, 'alpha-fix', { open: true, exec, platform: 'darwin', rand: 'abc123' });
  assert.deepEqual([r.opened, r.app], [true, 'iterm']);
  const launch = exec.calls[exec.calls.length - 1];
  assert.deepEqual(launch.args, terminal.osascriptArgv('iterm', r.command));
  assert.deepEqual(exec.calls[1].args, ['-e', 'application id "com.googlecode.iterm2" is running']);

  exec = fakeExec({ osa: (args) => (args.length === 2 ? { code: 1, stdout: '', stderr: "Can't get application" } : { code: 0, stdout: '', stderr: '' }) });
  r = await terminal.attach(home, 'alpha-fix', { open: true, exec, platform: 'darwin' });
  assert.deepEqual([r.opened, r.app], [true, 'terminal']);

  exec = fakeExec({ osa: (args) => (args.length === 2 ? { code: 0, stdout: 'false', stderr: '' } : { code: 1, stdout: '', stderr: 'Not authorized to send Apple events to Terminal. (-1743)' }) });
  r = await terminal.attach(home, 'alpha-fix', { open: true, exec, platform: 'darwin' });
  assert.equal(r.opened, false);
  assert.match(r.error, /Not authorized/);
  assert.ok(r.command, 'the copy fallback is still there');
});

// ---------- HTTP ----------

async function startServer(t, extra = {}) {
  const home = tempHome(t);
  const exec = fakeExec({ osa: (args) => ({ code: 0, stdout: args.length === 2 ? 'false' : '', stderr: '' }) });
  const server = createServer({ home, tmux: false, staleDays: 7, ordersDir: tmp(t, 'ship-deck-orders-'), memoryDir: tmp(t, 'ship-deck-mem-'), claudeDir: tmp(t, 'ship-deck-claude-'), exec, platform: 'darwin', ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) => fetch(base + '/api/attach', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1', ...headers }, body: JSON.stringify(body),
  });
  return { home, exec, base, port, post, server };
}

test('POST /api/attach: opens, copies, and maps refusals to statuses', async (t) => {
  const { exec, base, post } = await startServer(t);
  let r = await post({ id: 'alpha-fix', open: true });
  let body = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual([body.ok, body.opened, body.app], [true, true, 'terminal']);
  assert.equal(exec.calls.filter((c) => c.file === 'osascript').length, 2);

  r = await post({ id: 'alpha-fix' });
  body = await r.json();
  assert.equal(body.opened, false);
  assert.match(body.command, /^tmux new-session /);
  assert.equal(exec.calls.filter((c) => c.file === 'osascript').length, 2, 'copy does not launch');

  assert.equal((await post({ id: '../x', open: true })).status, 400);
  assert.equal((await post({ window: 'fleet:fm-alpha-fix', open: true })).status, 400, 'only an id is accepted');
  assert.equal((await post({ id: 'ghost', open: true })).status, 404);
  assert.equal((await post({ id: 'delta-block', open: true })).status, 409);
  assert.equal((await fetch(base + '/api/attach')).status, 404, 'POST only');
  const snap = await (await fetch(base + '/api/fleet')).json();
  assert.deepEqual(snap.terminal, { open: true });
  assert.equal(snap.tasks.find((x) => x.id === 'alpha-fix').backend, null);
});

test('POST /api/attach refuses cross-site, share-viewer and remote requests', async (t) => {
  const { exec, port, post, server } = await startServer(t);
  const before = exec.calls.length;
  assert.equal((await post({ id: 'alpha-fix', open: true }, { 'X-Ship-Deck': '0' })).status, 403);
  assert.equal((await post({ id: 'alpha-fix', open: true }, { Origin: 'https://ship-deck-relay.vercel.app' })).status, 403, 'share viewer origin');
  assert.equal((await post({ id: 'alpha-fix', open: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  // Another machine: right Host and headers, but the socket is not loopback.
  server.prependListener('connection', (sock) => Object.defineProperty(sock, 'remoteAddress', { value: '192.168.1.20' }));
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/attach', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ id: 'alpha-fix', open: true }));
  });
  assert.equal(r.status, 403);
  assert.match(r.text, /only from this computer/);
  assert.equal(exec.calls.length, before, 'nothing executed');
});

test('share viewers never get the window, backend or the attach route', () => {
  assert.ok(!share.WORKER_KEYS.includes('window') && !share.WORKER_KEYS.includes('backend'));
  for (const f of ['viewer.js', 'index.html', 'board.js']) {
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'relay', 'public', f), 'utf8').includes('/api/attach'), f);
  }
});

// ---------- UI state ----------

test('attachState: hidden off tmux, disabled with a reason, copy-only without a GUI terminal', () => {
  const live = { window: 'fleet:fm-a', backend: null, alive: true };
  assert.deepEqual(labels.attachState(live, true), { show: true, open: true, enabled: true, reason: null, hint: 'Opens its live window in your terminal; detach with Ctrl-b d.' });
  const linux = labels.attachState(live, false);
  assert.deepEqual([linux.show, linux.open, linux.enabled, linux.hint], [true, false, true, 'Paste in a terminal; detach with Ctrl-b d.']);
  assert.deepEqual(labels.attachState({ ...live, backend: 'herdr' }, true), { show: false });
  assert.deepEqual(labels.attachState({ ...live, window: null }, true), { show: false });
  assert.deepEqual(labels.attachState(null, true), { show: false });
  assert.equal(labels.attachState({ ...live, backend: 'tmux' }, true).enabled, true);
  const gone = labels.attachState({ ...live, alive: false }, true);
  assert.deepEqual([gone.show, gone.enabled, gone.reason], [true, false, 'Its tmux window is gone.']);
  const unknown = labels.attachState({ ...live, alive: null }, true);
  assert.deepEqual([unknown.enabled, unknown.reason], [false, 'Ship Deck cannot see tmux right now.']);
});
