'use strict';
// bin/install.sh in a temp HOME with a fixture firstmate home: the app copy and launcher,
// idempotent re-runs, nothing outside ~/.ship-deck, ~/.local/bin and the PATH line in ~/.zshrc
// unless --autostart is passed (--no-edit-path skips the rc), the autostart files with launchctl/systemctl/uname shims, and setting
// up firstmate from a local FIRSTMATE_REPO. No network: it installs from this checkout and
// curl/brew are logging fakes. Temp dirs and fabricated data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.sh');
const FIX = path.join(__dirname, 'fixtures');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-install-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A temp HOME (optionally with ~/firstmate) and a shim dir first on PATH: node and git
// link to the real ones; launchctl, systemctl, curl, uname (and brew) are fakes that log their argv.
// FIRSTMATE_REPO points at a local repo shaped like firstmate.
function sandbox(t, { firstmate = true, uname = null, brew = false } = {}) {
  const base = tempDir(t);
  const home = path.join(base, 'home');
  const shims = path.join(base, 'shims');
  fs.mkdirSync(home);
  fs.mkdirSync(shims);
  const log = path.join(base, 'calls.log');
  fs.symlinkSync(process.execPath, path.join(shims, 'node'));
  const git = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  if (git) fs.symlinkSync(git, path.join(shims, 'git'));
  for (const cmd of ['launchctl', 'systemctl', 'curl', ...(brew ? ['brew'] : [])]) {
    fs.writeFileSync(path.join(shims, cmd), `#!/bin/sh\necho "${cmd} $*" >> '${log}'\n`, { mode: 0o755 });
  }
  // Sleep settings are fakes too: pmset reads a state file that osascript/sudo "change".
  const sleepFile = path.join(base, 'sleepdisabled');
  fs.writeFileSync(path.join(shims, 'pmset'), `#!/bin/sh\nif [ "$*" = "-g batt" ]; then echo "Now drawing from 'AC Power'"; exit 0; fi\n[ "$(cat '${sleepFile}' 2>/dev/null)" = 1 ] && echo " SleepDisabled 1"\necho " sleep 1"\n`, { mode: 0o755 });
  for (const cmd of ['osascript', 'sudo']) {
    fs.writeFileSync(path.join(shims, cmd), `#!/bin/sh\necho "${cmd} $*" >> '${log}'\ncase "$*" in *"disablesleep 1"*) echo 1 > '${sleepFile}' ;; *"disablesleep 0"*) echo 0 > '${sleepFile}' ;; esac\n`, { mode: 0o755 });
  }
  if (uname) fs.writeFileSync(path.join(shims, 'uname'), `#!/bin/sh\necho ${uname}\n`, { mode: 0o755 });
  if (firstmate) {
    const fm = path.join(home, 'firstmate');
    fs.cpSync(path.join(FIX, 'home'), fm, { recursive: true });
    fs.writeFileSync(path.join(fm, 'AGENTS.md'), '# Sample firstmate home\n');
    fs.mkdirSync(path.join(fm, 'bin'));
    fs.writeFileSync(path.join(fm, 'bin', 'fm-spawn.sh'), '#!/bin/sh\nexit 0\n');
  }
  const repo = path.join(base, 'firstmate-repo');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Sample firstmate\n');
  fs.writeFileSync(path.join(repo, 'bin', 'fm-spawn.sh'), '#!/bin/sh\nexit 0\n');
  const g = (...a) => execFileSync(git, ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  // No terminal to ask on unless a test feeds an answer file (never the developer's /dev/tty).
  // Not started unless a test asks (SHIP_DECK_NO_START), never a real browser.
  const env = { HOME: home, PATH: `${shims}:/usr/bin:/bin`, SHELL: '/bin/zsh', FIRSTMATE_REPO: repo, SHIP_DECK_TTY: path.join(base, 'no-tty'), SHIP_DECK_NO_START: '1', SHIP_DECK_NO_OPEN: '1' };
  const run = (...args) => {
    const r = spawnSync('/bin/sh', [INSTALL, ...args], { env: { ...env, ...(run.env || {}) }, cwd: base, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const sleepDisabled = () => (fs.existsSync(sleepFile) ? fs.readFileSync(sleepFile, 'utf8').trim() : '0');
  return { base, home, shims, env, run, calls, sleepDisabled };
}

// Every path under dir with its size and mtime, for "nothing else changed" checks.
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

test('install.sh copies the app and writes a working launcher; re-runs are idempotent', (t) => {
  const s = sandbox(t);
  const fmBefore = fingerprint(path.join(s.home, 'firstmate'));
  const first = s.run('--no-edit-path');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(`Firstmate home: ${path.join(s.home, 'firstmate')} \\(default\\)`));
  assert.doesNotMatch(first.out, /Setting up firstmate/, 'home found: no clone');
  assert.match(first.out, /is not on your PATH/);

  const app = path.join(s.home, '.ship-deck', 'app');
  for (const f of ['server.js', 'package.json', 'lib/home.js', 'public/index.html', 'bin/start.sh', 'docs/TEAMMATE-SETUP.md', '.ship-deck-install']) {
    assert.ok(fs.existsSync(path.join(app, f)), f);
  }
  for (const f of ['test', 'relay', '.git']) assert.ok(!fs.existsSync(path.join(app, f)), `${f} not copied`);
  assert.equal(fs.statSync(path.join(s.home, '.ship-deck')).mode & 0o777, 0o700);

  const launcher = path.join(s.home, '.local', 'bin', 'ship-deck');
  assert.ok(fs.statSync(launcher).mode & 0o100, 'executable');
  const text = fs.readFileSync(launcher, 'utf8');
  assert.match(text, new RegExp(`'${app}/server\\.js'`));
  assert.doesNotMatch(text, /FM_HOME=/, 'the default home is auto-detected, not baked in');
  assert.match(execFileSync(launcher, ['--help'], { env: s.env, encoding: 'utf8' }), /^usage: ship-deck/);

  const again = s.run('--no-edit-path');
  assert.equal(again.code, 0, again.out);
  assert.equal(fs.readFileSync(launcher, 'utf8'), text, 'same launcher');
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.ship-deck')).sort(), ['app'], 'no staging or clone leftovers');
  // Nothing outside ~/.ship-deck and ~/.local/bin, and the firstmate home is untouched.
  assert.deepEqual(fs.readdirSync(s.home).sort(), ['.local', '.ship-deck', 'firstmate']);
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.local')), ['bin']);
  assert.deepEqual(fingerprint(path.join(s.home, 'firstmate')), fmBefore);
  assert.doesNotMatch(s.calls(), /launchctl|systemctl/, 'no launchctl/systemctl without --autostart');
});

test('install.sh without a firstmate home sets one up at ~/firstmate, then leaves it alone', (t) => {
  const s = sandbox(t, { firstmate: false });
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  const fm = path.join(s.home, 'firstmate');
  assert.match(r.out, new RegExp(`Setting up firstmate .* in ${fm}`));
  assert.ok(fs.existsSync(path.join(fm, '.git')) && fs.existsSync(path.join(fm, 'bin', 'fm-spawn.sh')), 'cloned');
  for (const d of ['state', 'data', 'projects']) assert.equal(fs.statSync(path.join(fm, d)).mode & 0o777, 0o700, d);
  assert.ok(require('../lib/home').looksLikeHome(fm), 'Ship Deck finds it');
  assert.doesNotMatch(fs.readFileSync(path.join(s.home, '.local', 'bin', 'ship-deck'), 'utf8'), /FM_HOME=/);
  assert.equal(fs.readFileSync(path.join(fm, 'data', 'learnings.md'), 'utf8'), fs.readFileSync(path.join(ROOT, 'docs', 'FIRST-MATE.md'), 'utf8'), 'a fresh home is taught the chat contract');
  assert.doesNotMatch(r.out, /tell your first mate once/);

  fs.writeFileSync(path.join(fm, 'state', 'w.status'), 'working: x\n');
  const before = fingerprint(fm);
  const again = s.run();
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /Setting up firstmate/);
  assert.deepEqual(fingerprint(fm), before, 'an existing home is left exactly as is');
});

test('install.sh tells an existing home how to learn the chat, without writing to it', (t) => {
  const s = sandbox(t);
  const r = s.run('--no-edit-path');
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(s.home, 'firstmate', 'data', 'learnings.md')));
  assert.match(r.out, /tell your first mate once: "Read ~\/\.ship-deck\/app\/docs\/FIRST-MATE\.md/);
  assert.match(r.out, /Try these first:\n {2}1\. Start your first mate in a new terminal: {2}cd ~\/firstmate && claude/);
  fs.writeFileSync(path.join(s.home, 'firstmate', 'data', 'learnings.md'), 'Ship Deck: node ~/.ship-deck/app/bin/orders.js list\n');
  assert.doesNotMatch(s.run('--no-edit-path').out, /tell your first mate once/, 'already taught');
});

test('install.sh installs Node with Homebrew when it is missing', (t) => {
  const s = sandbox(t, { brew: true });
  fs.rmSync(path.join(s.shims, 'node'));
  fs.writeFileSync(path.join(s.shims, 'brew'), `#!/bin/sh\necho "brew $*" >> '${path.join(s.base, 'calls.log')}'\ncase "$*" in *node*) ln -s '${process.execPath}' '${path.join(s.shims, 'node')}' ;; esac\n`, { mode: 0o755 });
  const r = s.run('--no-edit-path');
  assert.equal(r.code, 0, r.out);
  assert.match(s.calls(), /^brew install node$/m);
  assert.match(r.out, /ok {4}node v\d+/);
  fs.rmSync(path.join(s.shims, 'node'));
  fs.rmSync(path.join(s.shims, 'brew'));
  const none = s.run('--no-edit-path');
  assert.notEqual(none.code, 0);
  assert.match(none.out, /Node\.js 18 or newer is required/);
});

test('install.sh piped into sh (curl | sh) installs from --from, not from the current folder', (t) => {
  const s = sandbox(t);
  const src = path.join(s.base, 'src');
  const git = (...a) => execFileSync('git', a, { stdio: 'ignore' });
  fs.mkdirSync(src);
  for (const f of ['server.js', 'package.json', 'README.md', 'lib', 'public', 'bin', 'docs']) fs.cpSync(path.join(ROOT, f), path.join(src, f), { recursive: true });
  git('-C', src, 'init', '-q'); git('-C', src, 'add', '.'); git('-C', src, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const r = spawnSync('/bin/sh', ['-s', '--', '--from', src, '--no-edit-path'], { input: fs.readFileSync(INSTALL), env: s.env, cwd: s.home, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`Cloning Ship Deck from ${src}`));
  assert.ok(fs.existsSync(path.join(s.home, '.ship-deck', 'app', 'server.js')));
});

test('install.sh starts the deck, then a re-run restarts it on the new version', async (t) => {
  const s = sandbox(t);
  const port = 21000 + Math.floor(Math.random() * 8000);
  s.run.env = { SHIP_DECK_NO_START: '', SHIP_DECK_PORT: String(port) };
  const pidOf = () => Number(fs.readFileSync(path.join(s.home, '.ship-deck', 'server.pid'), 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { try { process.kill(pidOf()); } catch { /* gone */ } });
  const r = s.run('--no-edit-path');
  assert.equal(r.code, 0, r.out);
  const m = /Ship Deck is running at (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(r.out);
  assert.ok(m, r.out);
  const health = await (await fetch(m[1] + 'api/health')).json();
  assert.equal(health.home, path.join(s.home, 'firstmate'));
  const first = pidOf();
  const again = s.run('--no-edit-path');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /restarted on this version/);
  assert.ok(!alive(first), 'the old deck is stopped');
  assert.notEqual(pidOf(), first);
  assert.ok(alive(pidOf()), 'a new one runs');
});

test('install.sh restarts a deck from an older install that kept no pid file', async (t) => {
  const s = sandbox(t);
  assert.equal(s.run('--no-edit-path').code, 0);
  const app = path.join(s.home, '.ship-deck', 'app');
  // Stand-in for a deck started before start.sh kept a pid file (or in a terminal).
  const old = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(app, 'server.js')], { stdio: 'ignore' });
  t.after(() => { try { old.kill(); } catch { /* gone */ } });
  const exited = new Promise((res) => old.on('exit', res));
  const port = 21000 + Math.floor(Math.random() * 8000);
  s.run.env = { SHIP_DECK_NO_START: '', SHIP_DECK_PORT: String(port) };
  const r = s.run('--no-edit-path');
  const pidFile = path.join(s.home, '.ship-deck', 'server.pid');
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* gone */ } });
  assert.equal(r.code, 0, r.out);
  await exited;
  assert.match(r.out, /Ship Deck is running at http:\/\/127\.0\.0\.1:\d+\/ \(restarted on this version\)/);
});

test('install.sh refuses a non-empty folder that is not firstmate and installs nothing', (t) => {
  const s = sandbox(t, { firstmate: false });
  const fm = path.join(s.home, 'firstmate');
  fs.mkdirSync(fm);
  fs.writeFileSync(path.join(fm, 'notes.txt'), 'mine\n');
  const r = s.run();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is not empty and is not firstmate; it was left as is/);
  assert.deepEqual(fs.readdirSync(fm), ['notes.txt']);
  assert.ok(!fs.existsSync(path.join(s.home, '.ship-deck')), 'stopped before installing');
});

test('install.sh installs missing tools with Homebrew and the Claude Code installer', (t) => {
  const s = sandbox(t, { brew: true });
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(s.calls(), /^brew install tmux gh$/m);
  assert.match(s.calls(), /^curl -fsSL https:\/\/claude\.ai\/install\.sh$/m);
  assert.match(r.out, /MISSING claude .*: run {2}curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/, 'still missing: the exact command');
});

test('install.sh --home elsewhere remembers it in the launcher; a foreign app dir is refused', (t) => {
  const s = sandbox(t);
  const other = path.join(s.base, 'fm-elsewhere');
  fs.renameSync(path.join(s.home, 'firstmate'), other);
  const r = s.run('--home', other);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`Firstmate home: ${other} \\(--home\\)`));
  const fresh = path.join(s.base, 'fm-new');
  const made = s.run('--home', fresh);
  assert.equal(made.code, 0, made.out);
  assert.ok(require('../lib/home').looksLikeHome(fresh), 'set up at --home');
  assert.match(fs.readFileSync(path.join(s.home, '.local', 'bin', 'ship-deck'), 'utf8'), new RegExp(`FM_HOME='${fresh}'`));
  assert.equal(s.run('--home', other).code, 0);
  assert.match(fs.readFileSync(path.join(s.home, '.local', 'bin', 'ship-deck'), 'utf8'), new RegExp(`FM_HOME='${other}'`));

  fs.rmSync(path.join(s.home, '.ship-deck', 'app', '.ship-deck-install'));
  const refused = s.run();
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /was not made by this installer/);
  assert.ok(fs.existsSync(path.join(s.home, '.ship-deck', 'app', 'server.js')), 'left in place');
});

test('install.sh adds one PATH line to the shell rc file by default', (t) => {
  const s = sandbox(t);
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Added ~\/\.local\/bin to PATH in .*\.zshrc/);
  assert.equal(s.run('--edit-path').code, 0, 'old flag still accepted');
  const rc = fs.readFileSync(path.join(s.home, '.zshrc'), 'utf8');
  assert.equal(rc.match(/added by ship-deck install/g).length, 1, rc);
  assert.match(rc, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
});

test('install.sh ignores a pasted trailing # comment but still rejects unknown options', (t) => {
  const s = sandbox(t);
  // zsh without interactivecomments passes "# macOS/Linux, ..." on as arguments.
  const r = s.run('--no-edit-path', '#', 'macOS/Linux,', 'no', 'sudo,', '--bogus');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(s.home, '.local', 'bin', 'ship-deck')));
  assert.ok(!fs.existsSync(path.join(s.home, '.zshrc')), 'flags before the comment still apply');
  const bad = s.run('--bogus');
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /unknown option: --bogus/);
});

test('install.sh --autostart writes a LaunchAgent on macOS and loads it', (t) => {
  const s = sandbox(t, { uname: 'Darwin' });
  const r = s.run('--autostart');
  assert.equal(r.code, 0, r.out);
  const plist = fs.readFileSync(path.join(s.home, 'Library', 'LaunchAgents', 'local.ship-deck.plist'), 'utf8');
  assert.match(plist, /<string>local\.ship-deck<\/string>/);
  assert.match(plist, new RegExp(`<string>${path.join(s.home, '.ship-deck', 'app', 'bin', 'start.sh')}</string>`));
  assert.match(plist, /<string>--no-open<\/string>/);
  assert.match(plist, new RegExp(`<key>FM_HOME</key><string>${path.join(s.home, 'firstmate')}</string>`));
  assert.doesNotMatch(plist, /<!--[^]*--[^>][^]*-->/, 'no -- inside the XML comment');
  assert.match(s.calls(), /launchctl bootstrap gui\/\d+ .*local\.ship-deck\.plist/);
});

test('install.sh shares by default; --no-share is remembered by the launcher, start.sh and re-runs until --share', (t) => {
  const s = sandbox(t);
  const launcher = path.join(s.home, '.local', 'bin', 'ship-deck');
  const app = path.join(s.home, '.ship-deck', 'app');
  const start = path.join(app, 'bin', 'start.sh');
  const ON = 'share=1 relay=https://ship-deck-relay.vercel.app';
  // The env the launcher and start.sh hand to the server, without starting it.
  const envOf = (file, env = {}) => {
    const text = fs.readFileSync(file, 'utf8').replace(/^exec .*$/m, 'echo "share=${SHIP_DECK_SHARE-} relay=${SHIP_DECK_RELAY-}"; exit 0').replace(/^nohup node .*$/m, 'echo "share=${SHIP_DECK_SHARE-} relay=${SHIP_DECK_RELAY-}"; exit 0');
    const copy = path.join(path.dirname(file), '.probe');
    fs.writeFileSync(copy, text);
    try { return execFileSync('/bin/sh', [copy], { env: { ...s.env, ...env }, encoding: 'utf8' }).trim().split('\n').pop(); } finally { fs.rmSync(copy); }
  };
  const first = s.run('--no-edit-path');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Sharing: +on \(https:\/\/ship-deck-relay\.vercel\.app\)/);
  assert.equal(envOf(launcher), ON, 'on by default');
  assert.equal(envOf(start), ON, 'autostart (LaunchAgent) runs start.sh');
  assert.equal(envOf(launcher, { SHIP_DECK_SHARE: '' }), 'share= relay=', 'an empty SHIP_DECK_SHARE skips it once');

  const off = s.run('--no-edit-path', '--no-share');
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /Sharing: +off/);
  assert.equal(envOf(launcher), 'share= relay=');
  assert.equal(envOf(start), 'share= relay=');
  assert.equal(s.run('--no-edit-path').code, 0, 'an update re-run');
  assert.equal(envOf(launcher), 'share= relay=', '--no-share remembered');
  assert.equal(envOf(start), 'share= relay=');

  assert.equal(s.run('--no-edit-path', '--share').code, 0);
  assert.equal(envOf(launcher), ON);
  assert.equal(s.run('--no-edit-path', '--share-relay', 'https://relay.example.com/').code, 0);
  assert.equal(envOf(launcher), 'share=1 relay=https://relay.example.com');
  assert.equal(s.run('--no-edit-path').code, 0);
  assert.equal(envOf(launcher), 'share=1 relay=https://relay.example.com', 'another relay remembered');
  // An install recorded before sharing became the default (empty share_relay=) now shares.
  fs.chmodSync(path.join(app, '.ship-deck-install'), 0o600);
  fs.writeFileSync(path.join(app, '.ship-deck-install'), 'source=x\nrevision=\nshare_relay=\n');
  assert.equal(s.run('--no-edit-path').code, 0);
  assert.equal(envOf(launcher), ON);

  const bad = s.run('--share-relay', "http://evil.example.com/'x");
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /must be an https/);
});

test('install.sh --autostart writes and enables a systemd user unit on Linux', (t) => {
  const s = sandbox(t, { uname: 'Linux' });
  const r = s.run('--autostart');
  assert.equal(r.code, 0, r.out);
  const unit = fs.readFileSync(path.join(s.home, '.config', 'systemd', 'user', 'ship-deck.service'), 'utf8');
  assert.match(unit, new RegExp(`ExecStart=${path.join(s.home, '.local', 'bin', 'ship-deck')} --no-open`));
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(s.calls(), /systemctl --user enable --now ship-deck\.service/);
  assert.ok(!fs.existsSync(path.join(s.home, 'Library')), 'no LaunchAgent on Linux');
});

// macOS only (process.platform drives the CLI); pmset, osascript and sudo are the sandbox fakes.
test('install.sh keep-awake: on by default on a first install, asked, declinable, re-runs keep the choice', { skip: process.platform !== 'darwin' && 'macOS only' }, (t) => {
  const s = sandbox(t, { uname: 'Darwin' });
  let r = s.run('--no-edit-path');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Stay awake with the lid closed: .*password once/);
  assert.match(s.calls(), /^osascript -e do shell script "\/usr\/bin\/pmset -a disablesleep 1" .*with administrator privileges$/m, 'no terminal: the native dialog');
  assert.equal(s.sleepDisabled(), '1');
  assert.match(r.out, /Lid closed, stay awake: on: turn it off in Settings > You/);

  fs.writeFileSync(path.join(s.base, 'sleepdisabled'), '0');
  const before = s.calls();
  r = s.run('--no-edit-path');
  assert.equal(r.code, 0, r.out);
  const count = (x) => (x.match(/^(osascript|sudo) /gm) || []).length;
  assert.equal(count(s.calls()), count(before), 're-run: the user\'s off is left alone');
  assert.match(r.out, /Lid closed, stay awake: off/);
  r = s.run('--no-edit-path', '--keep-awake');
  assert.equal(s.sleepDisabled(), '1', '--keep-awake turns it on on a re-run');

  const d = sandbox(t, { uname: 'Darwin' });
  r = d.run('--no-edit-path', '--no-keep-awake');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(d.calls(), /osascript|sudo/);
  assert.equal(d.sleepDisabled(), '0');

  const q = sandbox(t, { uname: 'Darwin' });
  fs.writeFileSync(path.join(q.base, 'answer'), 'n\n');
  q.run.env = { SHIP_DECK_TTY: path.join(q.base, 'answer') };
  r = q.run('--no-edit-path');
  assert.match(r.out, /Enter to keep, n to skip/);
  assert.doesNotMatch(q.calls(), /osascript|sudo/, '"n" skips it');
  fs.writeFileSync(path.join(q.base, 'answer'), '\n');
  fs.rmSync(path.join(q.home, '.ship-deck'), { recursive: true });
  r = q.run('--no-edit-path');
  assert.equal(q.sleepDisabled(), '1', 'Enter keeps it on');
});

test('install.sh on Linux skips keep-awake', (t) => {
  const s = sandbox(t, { uname: 'Linux' });
  const r = s.run('--no-edit-path');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /stay awake/i);
  assert.doesNotMatch(s.calls(), /osascript|sudo/);
});

// ---------- ship-deck update ----------
// A bare "remote" holding this checkout's app files, and a work clone to push new commits from.
function deckRemote(s) {
  const bare = path.join(s.base, 'remote.git');
  const work = path.join(s.base, 'work');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(work);
  for (const f of ['server.js', 'package.json', 'README.md', 'lib', 'public', 'bin', 'docs']) fs.cpSync(path.join(ROOT, f), path.join(work, f), { recursive: true });
  git('-C', work, 'init', '-q', '-b', 'main');
  git('-C', work, 'add', '.');
  git('-C', work, 'commit', '-qm', 'first');
  git('-C', work, 'remote', 'add', 'origin', bare);
  git('-C', work, 'push', '-q', '-u', 'origin', 'main');
  const commit = (msg) => {
    fs.writeFileSync(path.join(work, 'docs', 'NEW.md'), msg + '\n');
    git('-C', work, 'add', '.');
    git('-C', work, 'commit', '-qm', msg);
    git('-C', work, 'push', '-q');
    return git('-C', work, 'rev-parse', '--short', 'HEAD');
  };
  return { bare, work, git, commit };
}

test('ship-deck update fast-forwards, reinstalls with the same choices and shows what changed', (t) => {
  const s = sandbox(t);
  const r = deckRemote(s);
  const first = s.run('--from', r.bare, '--no-share', '--no-edit-path', '--no-keep-awake');
  assert.equal(first.code, 0, first.out);
  const src = path.join(s.home, '.ship-deck', 'src');
  const app = path.join(s.home, '.ship-deck', 'app');
  assert.match(fs.readFileSync(path.join(app, '.ship-deck-install'), 'utf8'), new RegExp(`^source=${src}$`, 'm'), 'updates come from a kept checkout');
  const launcher = path.join(s.home, '.local', 'bin', 'ship-deck');
  const update = () => spawnSync(launcher, ['update'], { env: s.env, cwd: s.home, encoding: 'utf8' });

  let u = update();
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.match(u.stdout, /Already up to date/);

  const to = r.commit('Add the tide chart');
  u = update();
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.match(u.stdout, new RegExp(`Updated Ship Deck 0\\.1\\.0 \\([0-9a-f]+\\) -> 0\\.1\\.0 \\(${to}\\)`));
  assert.match(u.stdout, /What changed:\n {2}[0-9a-f]+ Add the tide chart\n/);
  assert.doesNotMatch(u.stdout, /Try these first/, 'no first-run tips on an update');
  assert.ok(fs.existsSync(path.join(app, 'docs', 'NEW.md')), 'the new version is installed');
  assert.match(fs.readFileSync(path.join(app, '.ship-deck-install'), 'utf8'), /^share_relay=off$/m, 'sharing choice kept');
  assert.ok(!fs.existsSync(path.join(s.home, '.zshrc')), 'PATH choice kept (no rc edit)');
  assert.doesNotMatch(s.calls(), /osascript|sudo/, 'no questions, no keep-awake change');

  // Re-running the curl install command is the same fast-forward.
  r.commit('Second change');
  const again = s.run('--from', r.bare, '--no-edit-path');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Updating Ship Deck from/);
  assert.match(fs.readFileSync(path.join(app, 'docs', 'NEW.md'), 'utf8'), /Second change/);
});

test('ship-deck update refuses local changes and a diverged branch, and changes nothing', (t) => {
  const s = sandbox(t);
  const r = deckRemote(s);
  assert.equal(s.run('--from', r.bare, '--no-edit-path').code, 0);
  const src = path.join(s.home, '.ship-deck', 'src');
  const app = path.join(s.home, '.ship-deck', 'app');
  const record = () => fs.readFileSync(path.join(app, '.ship-deck-install'), 'utf8');
  const before = record();
  const update = () => spawnSync('/bin/sh', [path.join(app, 'bin', 'update.sh')], { env: s.env, cwd: s.home, encoding: 'utf8' });
  r.commit('Upstream change');

  fs.appendFileSync(path.join(src, 'README.md'), 'my edit\n');
  let u = update();
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /has local changes\. Nothing was changed/);
  assert.match(fs.readFileSync(path.join(src, 'README.md'), 'utf8'), /my edit/, 'the edit is kept');
  assert.equal(record(), before);

  r.git('-C', src, 'commit', '-qam', 'local commit');
  u = update();
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /cannot fast-forward\. It was left as is/);
  assert.match(r.git('-C', src, 'log', '-1', '--format=%s'), /local commit/, 'never reset');
  assert.equal(record(), before);
});

test('ship-deck update restarts the deck that was running from this install', async (t) => {
  const s = sandbox(t);
  const r = deckRemote(s);
  assert.equal(s.run('--from', r.bare, '--no-edit-path').code, 0);
  const deck = path.join(s.home, '.ship-deck');
  // Stand-in for the running deck: its command line names this install's server.js.
  const fake = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(deck, 'app', 'server.js')], { stdio: 'ignore' });
  t.after(() => { try { fake.kill(); } catch { /* gone */ } });
  fs.writeFileSync(path.join(deck, 'server.pid'), String(fake.pid));
  const exited = new Promise((res) => fake.on('exit', res));
  r.commit('Restart me');
  const port = 21000 + Math.floor(Math.random() * 8000);
  const u = spawnSync('/bin/sh', [path.join(deck, 'app', 'bin', 'update.sh')], { env: { ...s.env, SHIP_DECK_NO_START: '', SHIP_DECK_PORT: String(port) }, cwd: s.home, encoding: 'utf8' });
  const pid = Number(fs.readFileSync(path.join(deck, 'server.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid); } catch { /* gone */ } });
  assert.equal(u.status, 0, u.stdout + u.stderr);
  await exited;
  assert.notEqual(pid, fake.pid);
  assert.match(u.stdout, /Ship Deck is running at http:\/\/127\.0\.0\.1:\d+\//);
  const health = await (await fetch(/(http:\/\/127\.0\.0\.1:\d+\/)/.exec(u.stdout)[1] + 'api/health')).json();
  assert.equal(health.pid, pid, 'the new deck runs');
});
