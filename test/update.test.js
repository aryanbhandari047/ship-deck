'use strict';
// lib/update.js (the "Update available" check and the Update button) and its routes, against local
// git repos in temp dirs; bin/update.sh itself is exercised in test/install.test.js. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const update = require('../lib/update');
const { createServer } = require('../server');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-update-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe', encoding: 'utf8' }).trim();

// <base>/remote.git, a clone at <base>/.ship-deck/src and an installed app recording its revision.
function installed(t) {
  const base = tempDir(t);
  const bare = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  git('init', '-q', '--bare', '-b', 'main', bare);
  git('init', '-q', '-b', 'main', work);
  const commit = (msg) => { fs.writeFileSync(path.join(work, 'f.txt'), msg); git('-C', work, 'add', '.'); git('-C', work, 'commit', '-qm', msg); return git('-C', work, 'rev-parse', 'HEAD'); };
  commit('first');
  git('-C', work, 'push', '-q', bare, 'main');
  const deck = path.join(base, '.ship-deck');
  const src = path.join(deck, 'src');
  git('clone', '-q', bare, src);
  const app = path.join(deck, 'app');
  fs.mkdirSync(app, { recursive: true });
  const record = (rev) => fs.writeFileSync(path.join(app, '.ship-deck-install'), `source=${src}\nrevision=${rev}\nshare_relay=off\n`);
  record(git('-C', src, 'rev-parse', '--short', 'HEAD'));
  const push = (msg) => { const sha = commit(msg); git('-C', work, 'push', '-q', bare, 'main'); return sha; };
  return { base, bare, deck, src, app, record, push };
}

test('check: up to date, then a newer commit on the remote, then offline', async (t) => {
  const i = installed(t);
  assert.deepEqual(await update.check({ appDir: i.app }), { supported: true, available: false, current: git('-C', i.src, 'rev-parse', '--short=7', 'HEAD'), latest: git('-C', i.src, 'rev-parse', '--short=7', 'HEAD') });
  const sha = i.push('second');
  const u = await update.check({ appDir: i.app });
  assert.equal(u.available, true);
  assert.equal(u.latest, sha.slice(0, 7));
  assert.equal(fs.readFileSync(path.join(i.src, 'f.txt'), 'utf8'), 'first', 'checking changes nothing');
  fs.rmSync(i.bare, { recursive: true });
  const off = await update.check({ appDir: i.app });
  assert.equal(off.available, false);
  assert.equal(off.offline, true);
});

test('check: an install ahead of its remote, or not from the installer, has no update', async (t) => {
  const i = installed(t);
  fs.writeFileSync(path.join(i.src, 'g.txt'), 'local');
  git('-C', i.src, 'add', '.');
  git('-C', i.src, 'commit', '-qm', 'local');
  i.record(git('-C', i.src, 'rev-parse', '--short', 'HEAD'));
  assert.equal((await update.check({ appDir: i.app })).available, false);
  assert.deepEqual(await update.check({ appDir: tempDir(t) }), { supported: false }, 'no install record');
  fs.writeFileSync(path.join(i.app, '.ship-deck-install'), 'source=/nowhere\nrevision=\n');
  assert.deepEqual(await update.check({ appDir: i.app }), { supported: false }, 'no revision');
});

// A child that exits when told, writing its "output" to the update log first.
function fakeSpawn(log) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  fn.finish = (code, text) => { fs.writeFileSync(log, text); calls[calls.length - 1].child.emit('exit', code); };
  return fn;
}

test('createUpdater: runs bin/update.sh detached once, then reports how it ended', async (t) => {
  const i = installed(t);
  const spawnFn = fakeSpawn(path.join(i.deck, 'update.log'));
  const u = update.createUpdater({ appDir: i.app, deckDir: i.deck, home: '/sample/firstmate', spawnFn });
  assert.equal(u.run().ok, false, 'not before a check found it supported');
  i.push('second');
  assert.equal((await u.refresh()).available, true);
  assert.deepEqual(u.run(), { ok: true, running: true });
  assert.deepEqual(u.run(), { ok: true, running: true }, 'a second click while running starts nothing');
  assert.equal(spawnFn.calls.length, 1);
  const [call] = spawnFn.calls;
  assert.equal(call.cmd, '/bin/sh');
  assert.deepEqual(call.args, [path.join(i.app, 'bin', 'update.sh')]);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.env.FM_HOME, '/sample/firstmate');
  assert.equal(call.opts.env.SHIP_DECK_NO_OPEN, '1');
  spawnFn.finish(1, 'Checking for updates\nship-deck update: x has local changes. Nothing was changed\n');
  const v = u.view();
  assert.equal(v.running, false);
  assert.deepEqual(v.result, { ok: false, message: 'Checking for updates\nship-deck update: x has local changes. Nothing was changed' });
});

test('/api/update: GET reports, POST runs only with the guard header, and only for installed decks', async (t) => {
  const home = tempDir(t);
  fs.cpSync(path.join(__dirname, 'fixtures', 'home'), home, { recursive: true });
  const runs = [];
  const updater = { view: () => ({ supported: true, available: true, current: 'aaaaaaa', latest: 'bbbbbbb', running: runs.length > 0 }), run: () => { runs.push(1); return { ok: true, running: true }; } };
  const start = async (opts) => {
    const server = createServer({ home, tmux: false, ordersDir: tempDir(t), claudeDir: tempDir(t), memoryDir: null, exec: async () => ({ code: 1 }), ...opts });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await start({ updater });
  assert.equal((await (await fetch(base + '/api/update')).json()).latest, 'bbbbbbb');
  assert.equal((await fetch(base + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(runs.length, 0);
  const post = await fetch(base + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: '{}' });
  assert.equal(post.status, 202);
  assert.equal(runs.length, 1);
  assert.equal((await (await fetch(base + '/api/health')).json()).pid, process.pid);
  const plain = await start({});
  assert.deepEqual(await (await fetch(plain + '/api/update')).json(), { supported: false });
  assert.equal((await fetch(plain + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: '{}' })).status, 409);
});
