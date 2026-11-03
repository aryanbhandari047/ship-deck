'use strict';
// Stay awake with the lid closed: pmset parsing, the CLI (sudo in a terminal, the native dialog
// otherwise, "macOS only" elsewhere) and GET/POST /api/awake. pmset, osascript and sudo are
// fakes over an in-memory flag: tests never change real sleep settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const awake = require('../lib/awake');
const { createServer } = require('../server');

const PMSET_ON = 'System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep                1\n';
const PMSET_OFF = 'System-wide power settings:\nCurrently in use:\n sleep                1 (sleep prevented by caffeinate)\n';

// A fake machine: exec answers pmset/osascript; sudo flips the flag.
function machine({ on = false, charger = true, battery = 76, cancel = false, failRead = false } = {}) {
  const m = { on, calls: [] };
  m.exec = async (file, args) => {
    m.calls.push([file, ...args].join(' '));
    if (file === 'pmset' && args.join(' ') === '-g') return failRead ? { code: 1, stdout: '', stderr: 'pmset: no' } : { code: 0, stdout: m.on ? PMSET_ON : PMSET_OFF, stderr: '' };
    if (file === 'pmset') return { code: 0, stdout: `Now drawing from '${charger ? 'AC' : 'Battery'} Power'\n -InternalBattery-0 (id=1)\t${battery}%; charging; present: true\n`, stderr: '' };
    if (file === 'osascript') {
      if (cancel) return { code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' };
      m.on = /disablesleep 1/.test(args[1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error('unexpected command ' + file);
  };
  m.sudo = (args) => { m.calls.push('sudo ' + args.join(' ')); m.on = args[3] === '1'; return 0; };
  return m;
}
function cli(argv, m, extra = {}) {
  const out = [];
  const err = [];
  return awake.cli(argv, { exec: m.exec, sudo: m.sudo, platform: 'darwin', tty: false, out: (s) => out.push(s), err: (s) => err.push(s), ...extra })
    .then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

test('parsers: SleepDisabled and the power source', () => {
  assert.equal(awake.parseSleepDisabled(PMSET_ON), true);
  assert.equal(awake.parseSleepDisabled(PMSET_OFF), false);
  assert.equal(awake.parseSleepDisabled(' SleepDisabled 0\n'), false);
  assert.equal(awake.parseSleepDisabled(''), false);
  assert.deepEqual(awake.parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=2)\t18%; discharging; 1:02 remaining present: true"), { charger: false, battery: 18 });
  assert.deepEqual(awake.parsePower("Now drawing from 'AC Power'\n"), { charger: true, battery: null }, 'a desktop Mac has no battery');
  assert.deepEqual(awake.parsePower(''), { charger: null, battery: null });
  assert.match(awake.adminScript(true), /^do shell script "\/usr\/bin\/pmset -a disablesleep 1" with prompt ".+" with administrator privileges$/);
  assert.match(awake.adminScript(false), /disablesleep 0/);
});

test('status reads pmset; non-macOS is unsupported without running anything', async () => {
  const m = machine({ on: true, charger: false, battery: 40 });
  assert.deepEqual(await awake.status({ exec: m.exec, platform: 'darwin' }), { supported: true, on: true, charger: false, battery: 40 });
  const l = machine();
  assert.deepEqual(await awake.status({ exec: l.exec, platform: 'linux' }), { supported: false, on: false, charger: null, battery: null });
  assert.deepEqual(l.calls, []);
  const bad = machine({ failRead: true });
  const s = await awake.status({ exec: bad.exec, platform: 'darwin' });
  assert.equal(s.on, null);
  assert.match(s.error, /pmset: no/);
});

test('CLI: status, on with sudo in a terminal, off with the dialog, no-ops and usage', async () => {
  const m = machine();
  let r = await cli(['status'], m);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Stay awake with the lid closed: off');
  assert.equal((await cli([], m)).out, r.out, 'status is the default');

  r = await cli(['on'], m, { tty: true });
  assert.equal(r.code, 0, r.err);
  assert.ok(m.calls.includes('sudo /usr/bin/pmset -a disablesleep 1'), 'the terminal\'s own sudo prompt');
  assert.ok(!m.calls.some((c) => c.startsWith('osascript')));
  assert.match(r.out, /password once[\s\S]*: on\n.*charger.*bag/);

  m.calls.length = 0;
  r = await cli(['on'], m, { tty: true });
  assert.equal(r.code, 0);
  assert.ok(!m.calls.some((c) => c.startsWith('sudo')), 'already on: no password asked');

  r = await cli(['off'], m);
  assert.equal(r.code, 0, r.err);
  assert.ok(m.calls.some((c) => /^osascript -e do shell script "\/usr\/bin\/pmset -a disablesleep 0"/.test(c)), 'no terminal: the native dialog');
  assert.equal(m.on, false);
  assert.match(r.out, /: off$/);

  assert.equal((await cli(['maybe'], m)).code, 2);
  assert.equal((await cli(['on', 'now'], m)).code, 2);
});

test('CLI: cancelled prompt, a change that did not stick, battery warning, non-macOS', async () => {
  let r = await cli(['on'], machine({ cancel: true }));
  assert.equal(r.code, 1);
  assert.match(r.err, /Cancelled; nothing changed/);

  const stuck = machine();
  stuck.sudo = () => 0;
  r = await cli(['on'], stuck, { tty: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not change/);

  const failing = machine();
  failing.sudo = () => 1;
  r = await cli(['on'], failing, { tty: true });
  assert.match(r.err, /sudo exited 1/);

  r = await cli(['status'], machine({ on: true, charger: false, battery: 22 }));
  assert.match(r.out, /On battery \(22%\): plug in the charger, or turn it off with: ship-deck awake off/);

  const l = machine();
  for (const c of ['status', 'on', 'off']) {
    r = await cli([c], l, { platform: 'linux' });
    assert.equal(r.code, 0);
    assert.equal(r.out, 'Stay awake with the lid closed is macOS only.');
  }
  assert.deepEqual(l.calls, []);
});

async function startServer(t, m, platform = 'darwin') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-awake-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  fs.cpSync(path.join(__dirname, 'fixtures', 'home'), home, { recursive: true });
  const server = createServer({ home, tmux: false, staleDays: 7, ordersDir: path.join(tmp, 'orders'), memoryDir: null, claudeDir: path.join(tmp, 'claude'), captainName: 'Ada', platform, awakeExec: m.exec, exec: async () => { throw new Error('no exec in tests'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async () => (await fetch(base + '/api/awake')).json(),
    post: async (body, headers = { 'X-Ship-Deck': '1' }) => {
      const r = await fetch(base + '/api/awake', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    },
  };
}

test('HTTP: the toggle reflects pmset, changes through the dialog, guards and non-macOS', async (t) => {
  const m = machine();
  const s = await startServer(t, m);
  assert.deepEqual(await s.get(), { supported: true, on: false, charger: true, battery: 76 });
  m.on = true;
  assert.equal((await s.get()).on, true, 'the real state, not a saved preference');

  let p = await s.post({ on: false });
  assert.equal(p.status, 200);
  assert.equal(p.data.ok, true);
  assert.equal(p.data.status.on, false);
  assert.ok(m.calls.some((c) => c.startsWith('osascript -e do shell script "/usr/bin/pmset -a disablesleep 0"')));

  assert.equal((await s.post({ on: 'yes' })).status, 400);
  assert.equal((await s.post({ on: true }, {})).status, 403, 'POST guard: X-Ship-Deck header');
  assert.equal(m.on, false, 'refused requests change nothing');

  const c = machine({ cancel: true });
  const sc = await startServer(t, c);
  p = await sc.post({ on: true });
  assert.equal(p.status, 200);
  assert.equal(p.data.cancelled, true);
  assert.equal(p.data.status.on, false);

  const l = machine();
  const sl = await startServer(t, l, 'linux');
  assert.equal((await sl.get()).supported, false);
  assert.equal((await sl.post({ on: true })).status, 400);
  assert.deepEqual(l.calls, []);
});
