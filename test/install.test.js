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
  const env = { HOME: home, PATH: `${shims}:/usr/bin:/bin`, SHELL: '/bin/zsh', FIRSTMATE_REPO: repo };
  const run = (...args) => {
    const r = spawnSync('/bin/sh', [INSTALL, ...args], { env, cwd: base, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return { base, home, env, run, calls };
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

  fs.writeFileSync(path.join(fm, 'state', 'w.status'), 'working: x\n');
  const before = fingerprint(fm);
  const again = s.run();
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /Setting up firstmate/);
  assert.deepEqual(fingerprint(fm), before, 'an existing home is left exactly as is');
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
