'use strict';
// Captain's actions: orders queue, orders CLI and wake check, window lookup,
// pane peek and fm-send (with an injected executor), data files, the Ship's
// Library allow-list, and the POST guard. Nothing here runs fm-send or touches
// a real tmux window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const orders = require('../lib/orders');
const wake = require('../lib/wake');
const actions = require('../lib/actions');
const library = require('../lib/library');
const { createServer } = require('../server');
const cli = require('../bin/orders');

const FIX = path.join(__dirname, 'fixtures', 'home');
const ROOT = path.join(__dirname, '..');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function tempHome(t) {
  const dir = tmp('ship-deck-act-');
  fs.cpSync(FIX, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tempDir(t, prefix = 'ship-deck-orders-') {
  const dir = tmp(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mode = (p) => fs.statSync(p).mode & 0o777;

// Records every call; never runs anything.
function fakeExec(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const exec = async (file, args, opts) => { calls.push({ file, args, opts }); return typeof result === 'function' ? result(file, args) : result; };
  exec.calls = calls;
  return exec;
}

// ---------- orders ----------

test('createOrder appends a pending JSON line with private permissions', (t) => {
  const dir = path.join(tempDir(t), '.ship-deck');
  const o = orders.createOrder(dir, { kind: 'cleanup', target: 'alpha-fix' });
  assert.match(o.id, orders.ORDER_ID_RE);
  assert.equal(o.status, 'pending');
  assert.equal(o.text, 'Clean up this worker');
  assert.equal(o.target, 'alpha-fix');
  assert.equal(mode(dir), 0o700);
  const file = path.join(dir, orders.ORDERS_FILE);
  assert.equal(mode(file), 0o600);
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(Object.keys(line), ['id', 'ts', 'kind', 'target', 'text', 'status']);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('{"id":"o-'), 'id is the first key (orders-check.sh relies on it)');

  const g = orders.createOrder(dir, { kind: 'order', text: '  line one\nline two\r\n\tend ' });
  assert.equal(g.target, null);
  assert.equal(g.text, 'line one line two end');
  assert.ok(g.id > o.id, 'ids are increasing');
});

test('validateOrder rejects bad kinds, ids, unknown targets and empty text', () => {
  const known = new Set(['alpha-fix']);
  assert.throws(() => orders.validateOrder({ kind: 'rm -rf', target: 'alpha-fix' }), /unknown order kind/);
  assert.throws(() => orders.validateOrder({ kind: 'cleanup' }), /invalid target/);
  for (const bad of ['../x', 'Alpha', '-x', 'a b', 'a;b', 'fm:alpha', '']) {
    assert.throws(() => orders.validateOrder({ kind: 'merge', target: bad }), /invalid target/, bad);
  }
  assert.throws(() => orders.validateOrder({ kind: 'status', target: 'ghost' }, known), /unknown target/);
  assert.throws(() => orders.validateOrder({ kind: 'answer', target: 'alpha-fix', text: '  ' }, known), /text is required/);
  assert.throws(() => orders.validateOrder({ kind: 'order', text: '' }), /text is required/);
  assert.throws(() => orders.validateOrder({ kind: 'order', text: 'x'.repeat(2001) }), /longer than 2000/);
  assert.deepEqual(orders.validateOrder({ kind: 'answer', target: 'alpha-fix', text: 'keep it' }, known),
    { kind: 'answer', target: 'alpha-fix', text: 'keep it' });
});

test('ack, list and pending computation', (t) => {
  const dir = tempDir(t);
  const a = orders.createOrder(dir, { kind: 'order', text: 'first' });
  const b = orders.createOrder(dir, { kind: 'status', target: 'alpha-fix' });
  const c = orders.createOrder(dir, { kind: 'merge', target: 'beta-scout' });
  fs.appendFileSync(path.join(dir, orders.ORDERS_FILE), 'not json\n{"broken":\n');

  let list = orders.listOrders(dir);
  assert.deepEqual(list.map((o) => o.id), [c.id, b.id, a.id], 'newest first, junk skipped');
  assert.ok(list.every((o) => o.pending && o.status === 'pending'));

  orders.ackOrder(dir, a.id, 'acknowledged', 'on it');
  orders.ackOrder(dir, b.id, 'acknowledged');
  orders.ackOrder(dir, b.id, 'done', 'status: green\nall good');
  assert.equal(mode(path.join(dir, orders.ACKS_FILE)), 0o600);
  fs.appendFileSync(path.join(dir, orders.ACKS_FILE), `{"id":"${c.id}","status":"bogus"}\n`);

  list = orders.listOrders(dir);
  const by = Object.fromEntries(list.map((o) => [o.id, o]));
  assert.equal(by[a.id].status, 'acknowledged');
  assert.equal(by[a.id].note, 'on it');
  assert.equal(by[a.id].pending, false);
  assert.equal(by[b.id].status, 'done', 'latest ack wins');
  assert.equal(by[b.id].note, 'status: green all good');
  assert.equal(by[c.id].pending, true, 'an invalid ack status does not count');
  assert.deepEqual(orders.listOrders(dir, { pendingOnly: true }).map((o) => o.id), [c.id]);

  assert.throws(() => orders.ackOrder(dir, 'o-nope', 'done'), /no such order/);
  assert.throws(() => orders.ackOrder(dir, a.id, 'maybe'), /status must be one of/);
  assert.deepEqual(orders.listOrders(tempDir(t)), [], 'missing files are an empty queue');
});

test('bin/orders.js list and ack', (t) => {
  const dir = tempDir(t);
  const a = orders.createOrder(dir, { kind: 'cleanup', target: 'alpha-fix' });
  orders.createOrder(dir, { kind: 'order', text: 'land the harbor fix' });
  const run = (...argv) => {
    const out = [];
    const err = [];
    const code = cli.main(argv, dir, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  let r = run('list', '--pending');
  assert.equal(r.code, 0);
  assert.match(r.out, /pending\s+cleanup alpha-fix/);
  assert.match(r.out, /land the harbor fix/);

  r = run('ack', a.id, 'done', 'cleaned', 'up');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${a.id} done`);
  r = run('list', '--pending', '--json');
  assert.deepEqual(JSON.parse(r.out).map((o) => o.kind), ['order']);
  r = run('list');
  assert.match(r.out, /done\s+cleanup alpha-fix/);
  assert.match(r.out, /note: cleaned up/);

  assert.equal(run('ack', a.id, 'whatever').code, 1);
  assert.equal(run('ack', 'o-missing', 'done').code, 1);
  assert.equal(run('ack').code, 2);
  assert.equal(run('frob').code, 2);

  // Real process, HOME-based default dir.
  const home = tempDir(t, 'ship-deck-home-');
  const env = { ...process.env, HOME: home };
  delete env.SHIP_DECK_ORDERS_DIR;
  assert.equal(execFileSync('node', [path.join(ROOT, 'bin/orders.js'), 'list'], { env, encoding: 'utf8' }).trim(), 'no orders');
});

test('bin/orders-check.sh: one line for new orders, cursor in ~/.ship-deck', (t) => {
  const home = tempDir(t, 'ship-deck-home-');
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  const check = () => execFileSync('/bin/sh', [path.join(ROOT, 'bin/orders-check.sh')], { env, encoding: 'utf8' });
  const dir = path.join(home, '.ship-deck');
  const cursor = path.join(dir, 'orders-check.cursor');

  assert.equal(check(), '', 'no orders file: silent');
  assert.equal(fs.existsSync(dir), false, 'does not create the dir');

  orders.createOrder(dir, { kind: 'order', text: 'one' });
  const b = orders.createOrder(dir, { kind: 'order', text: 'two with "id":"o-99999999T999999999Z-ffff" inside' });
  assert.equal(check(), 'ship-deck: 2 new captain order(s)\n');
  assert.equal(fs.readFileSync(cursor, 'utf8').trim(), b.id, 'cursor is the newest id, not text that looks like one');
  assert.equal(mode(cursor), 0o600);
  assert.equal(check(), '', 'nothing new: silent');

  orders.ackOrder(dir, b.id, 'done');
  assert.equal(check(), '', 'acks are not new orders');
  const c = orders.createOrder(dir, { kind: 'status', target: 'alpha-fix' });
  fs.appendFileSync(path.join(dir, orders.ORDERS_FILE), 'garbage line\n');
  assert.equal(check(), 'ship-deck: 1 new captain order(s)\n');
  assert.equal(fs.readFileSync(cursor, 'utf8').trim(), c.id);

  const started = process.hrtime.bigint();
  check();
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000, 'finishes in under a second');

  const alt = tempDir(t);
  orders.createOrder(alt, { kind: 'order', text: 'elsewhere' });
  assert.equal(execFileSync('/bin/sh', [path.join(ROOT, 'bin/orders-check.sh')], { env: { ...env, SHIP_DECK_ORDERS_DIR: alt }, encoding: 'utf8' }),
    'ship-deck: 1 new captain order(s)\n');
});

// ---------- window lookup, peek, send ----------

test('lookupWindow reads the window from meta and validates it strictly', (t) => {
  const home = tempHome(t);
  assert.equal(actions.lookupWindow(home, 'alpha-fix'), 'fleet:fm-alpha-fix');
  assert.equal(actions.lookupWindow(home, 'gamma-decision'), 'fleet:fm-gamma-decision');
  fs.writeFileSync(path.join(home, 'state', 'no-window.meta'), 'kind=ship\n');
  assert.equal(actions.lookupWindow(home, 'no-window'), null, 'no window in meta');
  assert.equal(actions.lookupWindow(home, 'ghost'), null, 'no meta');
  for (const bad of ['../state/alpha-fix', 'ALPHA-FIX', '-t', 'alpha_fix', 'alpha-fix\n', '']) {
    assert.equal(actions.lookupWindow(home, bad), null, JSON.stringify(bad));
  }
  const evil = ['-t evil:0', 'fleet:fm-x;rm -rf /', 'fleet', 'fleet:$(id)', 'a:b:c', 'fleet:-x', 'fleet: x'];
  evil.forEach((w, i) => {
    fs.writeFileSync(path.join(home, 'state', `evil-${i}.meta`), `window=${w}\nkind=ship\n`);
    assert.equal(actions.lookupWindow(home, `evil-${i}`), null, w);
  });
});

test('peekPane runs only tmux capture-pane -e -J on the meta window', async (t) => {
  const home = tempHome(t);
  const exec = fakeExec({ code: 0, stdout: Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n') + '\n\n\n', stderr: '' });
  const r = await actions.peekPane(home, 'alpha-fix', exec);
  assert.deepEqual(exec.calls.map((c) => [c.file, c.args]), [['tmux', ['capture-pane', '-p', '-e', '-J', '-t', 'fleet:fm-alpha-fix', '-S', '-80']]]);
  assert.equal(r.window, 'fleet:fm-alpha-fix');
  assert.equal(r.text.split('\n').length, 80);
  assert.equal(r.text.split('\n').at(-1), 'line 119', 'trailing blank lines trimmed');

  fs.writeFileSync(path.join(home, 'state', 'no-window.meta'), 'kind=ship\n');
  await assert.rejects(actions.peekPane(home, 'no-window', exec), (e) => e.status === 404);
  await assert.rejects(actions.peekPane(home, '../x', exec), (e) => e.status === 400);
  await assert.rejects(actions.peekPane(home, 'alpha-fix', fakeExec({ code: 1, stdout: '', stderr: "can't find window" })), /can't find window/);
  assert.equal(exec.calls.length, 1);
});

test('sendMessage runs exactly fm-send.sh <window> <message> with FM_HOME', async (t) => {
  const home = tempHome(t);
  const exec = fakeExec({ code: 0, stdout: '', stderr: '' });
  const r = await actions.sendMessage(home, 'alpha-fix', '  please rebase\non main  ', exec);
  assert.equal(r.ok, true);
  assert.equal(exec.calls.length, 1);
  const c = exec.calls[0];
  assert.equal(c.file, path.join(home, 'bin', 'fm-send.sh'));
  assert.deepEqual(c.args, ['fleet:fm-alpha-fix', 'please rebase on main']);
  assert.equal(c.opts.env.FM_HOME, home);
  assert.equal(c.opts.shell, undefined, 'no shell');

  await assert.rejects(actions.sendMessage(home, 'alpha-fix', ' \n ', exec), /empty/);
  await assert.rejects(actions.sendMessage(home, 'alpha-fix', 'x'.repeat(2001), exec), /longer than 2000/);
  await assert.rejects(actions.sendMessage(home, 'alpha-fix', '--key Enter', exec), /may not start with/);
  fs.writeFileSync(path.join(home, 'state', 'no-window.meta'), 'kind=ship\n');
  await assert.rejects(actions.sendMessage(home, 'no-window', 'hi', exec), (e) => e.status === 404);
  await assert.rejects(actions.sendMessage(home, 'Alpha', 'hi', exec), (e) => e.status === 400);
  assert.equal(exec.calls.length, 1, 'rejected sends never execute');

  const failed = await actions.sendMessage(home, 'alpha-fix', 'hi', fakeExec({ code: 1, stdout: '', stderr: 'error: swallowed Enter' }));
  assert.equal(failed.ok, false);
  assert.match(failed.output, /swallowed Enter/);
});

test('readDataFile only serves regular files directly under data/<id>/', (t) => {
  const home = tempHome(t);
  assert.match(actions.readDataFile(home, 'beta-scout', 'report.md').text, /\S/);
  assert.match(actions.readDataFile(home, 'beta-scout', 'brief.md').text, /# Task/);
  const outside = path.join(home, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(home, 'data', 'beta-scout', 'link.md'));
  assert.throws(() => actions.readDataFile(home, 'beta-scout', 'link.md'), (e) => e.status === 403);
  for (const [id, name] of [['beta-scout', '../../secret.txt'], ['..', 'backlog.md'], ['beta-scout', '.hidden'], ['beta-scout', ''], ['Beta', 'report.md']]) {
    assert.throws(() => actions.readDataFile(home, id, name), (e) => e.status === 400, `${id}/${name}`);
  }
  assert.throws(() => actions.readDataFile(home, 'beta-scout', 'nope.md'), (e) => e.status === 404);
});

// ---------- ship's library ----------

test('library lists an allow-list of home files and memory *.md, MEMORY.md first', (t) => {
  const home = tempHome(t);
  const mem = tempDir(t, 'ship-deck-mem-');
  fs.writeFileSync(path.join(mem, 'zeta-rule.md'), '# zeta');
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [zeta](zeta-rule.md)');
  fs.writeFileSync(path.join(mem, 'alpha-rule.md'), '# alpha');
  fs.writeFileSync(path.join(mem, 'notes.txt'), 'not markdown');
  fs.mkdirSync(path.join(mem, 'sub.md'));

  const entries = library.listLibrary(home, mem);
  const keys = entries.map((e) => e.key);
  assert.deepEqual(keys, [
    'home:AGENTS.md', 'home:data/captain.md', 'home:data/captain-shared.md', 'home:data/learnings.md',
    'home:data/projects.md', 'home:data/secondmates.md', 'home:data/backlog.md',
    'memory:MEMORY.md', 'memory:alpha-rule.md', 'memory:zeta-rule.md',
    'skill:firstmate:harbor-watch',
  ]);
  const by = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.equal(by['home:AGENTS.md'].exists, false, 'missing files are listed as missing');
  assert.equal(by['home:data/projects.md'].exists, true);
  assert.ok(by['home:data/projects.md'].mtime > 0);
  assert.equal(by['home:data/captain.md'].title, "Captain's preferences", 'home files have plain titles');
  assert.equal(by['home:data/captain.md'].where, 'data/captain.md');
  assert.equal(by['memory:MEMORY.md'].title, 'Memory index');
  assert.equal(by['memory:alpha-rule.md'].title, 'Alpha rule');
  assert.equal(by['memory:alpha-rule.md'].where, 'memory/alpha-rule.md');
  for (const e of entries) assert.ok(!e.where.startsWith('/'), `${e.key}: where is never an absolute path`);

  assert.match(library.readLibraryEntry(home, mem, 'memory:MEMORY.md').text, /zeta-rule/);
  assert.equal(library.readLibraryEntry(home, mem, 'home:AGENTS.md').text, null);
  for (const bad of ['memory:notes.txt', 'memory:../secret.md', 'home:../x', '/etc/passwd', 'home:state/alpha-fix.meta', null, 7]) {
    assert.equal(library.readLibraryEntry(home, mem, bad), null, String(bad));
  }

  const none = library.listLibrary(home, path.join(mem, 'nope'));
  assert.deepEqual(none.filter((e) => e.group === 'First mate memory').map((e) => [e.key, e.exists]), [['memory:MEMORY.md', false]]);
});

// ---------- HTTP: guards and endpoints ----------

async function startServer(t, extra = {}) {
  const home = tempHome(t);
  const ordersDir = tempDir(t);
  const memoryDir = tempDir(t, 'ship-deck-mem-');
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index');
  const exec = fakeExec((file, args) => (file === 'tmux' ? { code: 0, stdout: `pane of ${args[args.indexOf('-t') + 1]}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }));
  const claudeDir = tempDir(t, 'ship-deck-claude-');
  const server = createServer({ home, tmux: false, staleDays: 7, ordersDir, memoryDir, claudeDir, exec, ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { home, ordersDir, exec, base, port, post };
}

test('POST endpoints reject CSRF: missing header, foreign Origin, bad Host, cross-site', async (t) => {
  const { base, port, post, exec, ordersDir } = await startServer(t);
  const body = { kind: 'order', text: 'csrf attempt' };
  const http = require('node:http');
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/orders', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  assert.equal((await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'no X-Ship-Deck');
  assert.equal((await post('/api/orders', body, { 'X-Ship-Deck': '0' })).status, 403);
  assert.equal((await post('/api/orders', body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/orders', body, { Origin: `http://127.0.0.1:${port + 1}` })).status, 403);
  assert.equal((await post('/api/orders', body, { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/orders', body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/orders', JSON.stringify(body), { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal(await raw({ 'X-Ship-Deck': '1', Host: `evil.example:${port}` }), 421, 'DNS rebinding Host');
  assert.equal(await raw({ 'X-Ship-Deck': '1', Host: '127.0.0.1:1' }), 421);
  assert.equal((await post('/api/send', { id: 'alpha-fix', message: 'hi' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(exec.calls.length, 0, 'nothing executed');
  assert.deepEqual(orders.listOrders(ordersDir), [], 'nothing queued');

  assert.equal((await post('/api/orders', body, { Origin: `http://localhost:${port}` })).status, 200);
  assert.equal(await raw({ 'X-Ship-Deck': '1', Host: `localhost:${port}` }), 200);
  assert.equal(orders.listOrders(ordersDir).length, 2);
  assert.equal((await post('/api/orders', 'x'.repeat(20000))).status, 413);
  assert.equal((await post('/api/orders', '{nope')).status, 400);
  assert.equal((await post('/api/fleet', {})).status, 405, 'only the action routes accept POST');
});

test('HTTP orders: create, see pending in the snapshot, ack shows up', async (t) => {
  const { base, post, ordersDir } = await startServer(t);
  let r = await post('/api/orders', { kind: 'merge', target: 'alpha-fix' });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.status, 'pending');
  assert.equal((await post('/api/orders', { kind: 'merge', target: 'ghost' })).status, 400, 'target must have a meta');
  assert.equal((await post('/api/orders', { kind: 'merge', target: '../x' })).status, 400);

  let s = await (await fetch(base + '/api/fleet')).json();
  assert.equal(s.orders.pending, 1);
  assert.equal(s.orders.list[0].id, order.id);
  orders.ackOrder(ordersDir, order.id, 'declined', 'CI is red');
  s = await (await fetch(base + '/api/fleet')).json();
  assert.equal(s.orders.pending, 0);
  assert.equal(s.orders.list[0].status, 'declined');
  assert.equal(s.orders.list[0].note, 'CI is red');
});

test('HTTP send and peek use the meta window and the injected executor', async (t) => {
  const { base, post, exec, home } = await startServer(t);
  let r = await post('/api/send', { id: 'alpha-fix', message: 'status please', window: 'evil:0' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(exec.calls.at(-1).args, ['fleet:fm-alpha-fix', 'status please'], 'client-supplied window is ignored');
  assert.equal(exec.calls.at(-1).file, path.join(home, 'bin', 'fm-send.sh'));

  assert.equal((await post('/api/send', { id: 'ghost', message: 'hi' })).status, 404);
  assert.equal((await post('/api/send', { id: '../alpha-fix', message: 'hi' })).status, 400);
  fs.writeFileSync(path.join(home, 'state', 'no-window.meta'), 'kind=ship\n');
  assert.equal((await post('/api/send', { id: 'no-window', message: 'hi' })).status, 404, 'no window recorded');
  assert.equal((await post('/api/send', { id: 'alpha-fix', message: '' })).status, 400);
  const before = exec.calls.length;

  r = await fetch(base + '/api/peek/alpha-fix');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'pane of fleet:fm-alpha-fix');
  assert.deepEqual(exec.calls.at(-1).args, ['capture-pane', '-p', '-e', '-J', '-t', 'fleet:fm-alpha-fix', '-S', '-80']);
  assert.equal((await fetch(base + '/api/peek/ghost')).status, 404);
  assert.equal((await fetch(base + '/api/peek/..%2Fx')).status, 404);
  assert.equal(exec.calls.length, before + 1);
});

test('HTTP data files and library endpoints', async (t) => {
  const { base } = await startServer(t);
  let s = await (await fetch(base + '/api/fleet')).json();
  assert.deepEqual(s.tasks.find((x) => x.id === 'beta-scout').files, ['brief.md', 'report.md']);
  let r = await fetch(base + '/api/file/beta-scout/brief.md');
  assert.equal(r.status, 200);
  assert.match((await r.json()).text, /# Task/);
  assert.equal((await fetch(base + '/api/file/beta-scout/..%2F..%2Fstate%2Falpha-fix.meta')).status, 400);
  assert.equal((await fetch(base + '/api/file/beta-scout/missing.md')).status, 404);

  const lib = await (await fetch(base + '/api/library')).json();
  assert.equal(lib.entries[0].key, 'home:AGENTS.md');
  assert.ok(lib.entries.some((e) => e.key === 'memory:MEMORY.md' && e.exists));
  r = await fetch(base + '/api/library/file?key=' + encodeURIComponent('memory:MEMORY.md'));
  assert.equal((await r.json()).text, '# Memory index');
  r = await fetch(base + '/api/library/file?key=' + encodeURIComponent('home:AGENTS.md'));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, null, 'missing file');
  assert.equal((await fetch(base + '/api/library/file?key=' + encodeURIComponent('/etc/passwd'))).status, 404);
  assert.equal((await fetch(base + '/api/library/file')).status, 404);
});

test('actions never write under the home except the wake inbox', async (t) => {
  const { base, post, home } = await startServer(t);
  const snap = () => {
    const out = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const st = fs.lstatSync(p);
        out[path.relative(home, p)] = `${st.size}:${st.mtimeMs}`;
        if (e.isDirectory()) walk(p);
      }
    };
    walk(home);
    return out;
  };
  const before = snap();
  await post('/api/orders', { kind: 'cleanup', target: 'alpha-fix' });
  await post('/api/send', { id: 'alpha-fix', message: 'hi' });
  await fetch(base + '/api/peek/alpha-fix');
  await fetch(base + '/api/file/beta-scout/report.md');
  await fetch(base + '/api/library');
  const after = snap();
  const inbox = path.join('state', wake.INBOX);
  assert.ok(after[inbox]);
  delete after[inbox];
  delete after.state; delete before.state; // dir mtime moves when the inbox is created
  assert.deepEqual(after, before);
});

test('wake: one line per order, newlines collapsed, text truncated', async (t) => {
  const { post, home, ordersDir } = await startServer(t);
  const inbox = path.join(home, 'state', wake.INBOX);
  const long = 'line one\nline two\r\n' + 'x'.repeat(200);
  const a = await (await post('/api/orders', { kind: 'chat', text: long })).json();
  const b = await (await post('/api/orders', { kind: 'cleanup', target: 'alpha-fix' })).json();
  const lines = fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const text = lines[0].slice(`message: ${a.order.id} chat `.length);
  assert.ok(lines[0].startsWith(`message: ${a.order.id} chat line one line two x`));
  assert.equal(text.length, 80);
  assert.ok(lines[1].startsWith(`message: ${b.order.id} cleanup `));
  assert.equal(mode(inbox), 0o644);
  assert.equal(orders.listOrders(ordersDir).length, 2);
});

test('wake: --no-wake writes nothing', async (t) => {
  const { post, home } = await startServer(t, { wake: false });
  assert.equal((await post('/api/orders', { kind: 'chat', text: 'hi' })).status, 200);
  assert.ok(!fs.existsSync(path.join(home, 'state', wake.INBOX)));
});

test('wake: unwritable state dir is logged and the order still queues', async (t) => {
  const { post, home, ordersDir } = await startServer(t);
  const state = path.join(home, 'state');
  fs.chmodSync(state, 0o500);
  const logs = [];
  let status;
  try {
    assert.equal(wake.wake(home, { id: 'o-x', kind: 'chat', text: 't' }, (m) => logs.push(m)), false);
    status = (await post('/api/orders', { kind: 'chat', text: 'still queued' })).status;
  } finally { fs.chmodSync(state, 0o755); } // restore before the temp home is removed
  assert.equal(logs.length, 1);
  assert.equal(status, 200);
  assert.equal(orders.listOrders(ordersDir).length, 1);
  assert.ok(!fs.existsSync(path.join(state, wake.INBOX)));
});

test('wake: appends to an existing inbox without truncating', (t) => {
  const home = tempHome(t);
  const inbox = path.join(home, 'state', wake.INBOX);
  fs.writeFileSync(inbox, 'earlier\n');
  wake.wake(home, { id: 'o-1', kind: 'new-task', text: 'go' });
  assert.equal(fs.readFileSync(inbox, 'utf8'), 'earlier\nmessage: o-1 new-task go\n');
});
