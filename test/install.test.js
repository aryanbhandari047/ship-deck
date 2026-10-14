'use strict';
// bin/install.sh in a temp HOME with a fixture firstmate home: the app copy and launcher,
// idempotent re-runs, nothing outside ~/.ship-deck and ~/.local/bin unless --autostart or
// --edit-path is passed, and the autostart files with launchctl/systemctl/uname shims.
// No network: it installs from this checkout. Temp dirs and fabricated data only.
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
// link to the real ones; launchctl, systemctl and uname are fakes that log their argv.
function sandbox(t, { firstmate = true, uname = null } = {}) {
  const base = tempDir(t);
  const home = path.join(base, 'home');
  const shims = path.join(base, 'shims');
  fs.mkdirSync(home);
  fs.mkdirSync(shims);
  const log = path.join(base, 'calls.log');
  fs.symlinkSync(process.execPath, path.join(shims, 'node'));
  const git = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  if (git) fs.symlinkSync(git, path.join(shims, 'git'));
  for (const cmd of ['launchctl', 'systemctl']) {
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
  const env = { HOME: home, PATH: `${shims}:/usr/bin:/bin`, SHELL: '/bin/zsh' };
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
  const first = s.run();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(`Firstmate home: ${path.join(s.home, 'firstmate')} \\(default\\)`));
  assert.doesNotMatch(first.out, /git clone/, 'home found: no clone hint');
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

  const again = s.run();
  assert.equal(again.code, 0, again.out);
  assert.equal(fs.readFileSync(launcher, 'utf8'), text, 'same launcher');
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.ship-deck')).sort(), ['app'], 'no staging or clone leftovers');
  // Nothing outside ~/.ship-deck and ~/.local/bin, and the firstmate home is untouched.
  assert.deepEqual(fs.readdirSync(s.home).sort(), ['.local', '.ship-deck', 'firstmate']);
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.local')), ['bin']);
  assert.deepEqual(fingerprint(path.join(s.home, 'firstmate')), fmBefore);
  assert.equal(s.calls(), '', 'no launchctl/systemctl without --autostart');
});

test('install.sh without a firstmate home prints the clone command and still installs', (t) => {
  const s = sandbox(t, { firstmate: false });
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /git clone https:\/\/github\.com\/kunchenguid\/firstmate ~\/firstmate/);
  assert.ok(!fs.existsSync(path.join(s.home, 'firstmate')), 'never clones firstmate itself');
  assert.ok(fs.existsSync(path.join(s.home, '.local', 'bin', 'ship-deck')));
});

test('install.sh --home elsewhere remembers it in the launcher; a foreign app dir is refused', (t) => {
  const s = sandbox(t);
  const other = path.join(s.base, 'fm-elsewhere');
  fs.renameSync(path.join(s.home, 'firstmate'), other);
  const r = s.run('--home', other);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`Firstmate home: ${other} \\(--home\\)`));
  assert.match(fs.readFileSync(path.join(s.home, '.local', 'bin', 'ship-deck'), 'utf8'), new RegExp(`FM_HOME='${other}'`));

  fs.rmSync(path.join(s.home, '.ship-deck', 'app', '.ship-deck-install'));
  const refused = s.run();
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /was not made by this installer/);
  assert.ok(fs.existsSync(path.join(s.home, '.ship-deck', 'app', 'server.js')), 'left in place');
});

test('install.sh --edit-path adds one PATH line to the shell rc file', (t) => {
  const s = sandbox(t);
  assert.equal(s.run('--edit-path').code, 0);
  assert.equal(s.run('--edit-path').code, 0);
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
