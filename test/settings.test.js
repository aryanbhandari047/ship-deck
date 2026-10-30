'use strict';
// Settings > You: the captain's form of address. Default "Captain", change, persistence across
// restarts, the empty value (no title), validation, the optional `address` message to the first
// mate, the bin/orders.js reminder, and the fleet home staying untouched (only the wake line).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../lib/settings');
const orders = require('../lib/orders');
const cli = require('../bin/orders.js');
const { createServer } = require('../server');

const FIX = path.join(__dirname, 'fixtures', 'home');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tempHome(t) {
  const dir = tempDir(t, 'ship-deck-home-');
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}
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
async function startServer(t, { home, ordersDir, captainName = 'Ada Lovelace' }) {
  const server = createServer({ home, tmux: false, staleDays: 7, ordersDir, memoryDir: null, claudeDir: tempDir(t, 'ship-deck-claude-'), captainName, exec: async () => { throw new Error('no exec in tests'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (p) => (await fetch(base + p)).json(),
    post: async (body, headers = { 'X-Ship-Deck': '1' }) => {
      const r = await fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
function runCli(argv, dir) {
  const out = [];
  const code = cli.main(argv, dir, (s) => out.push(s), () => {});
  return { code, out };
}

test('lib: defaults to Captain, saves, keeps an empty value and rejects bad ones', (t) => {
  const dir = tempDir(t, 'ship-deck-orders-');
  assert.deepEqual(settings.readSettings(dir), { address: 'Captain' }, 'no file: the default');
  assert.equal(settings.writeSettings(dir, { address: '  Boss  ' }).address, 'Boss', 'trimmed');
  assert.deepEqual(settings.readSettings(dir), { address: 'Boss' });
  assert.equal((fs.statSync(path.join(dir, settings.FILE)).mode & 0o777), 0o600);
  assert.equal(settings.writeSettings(dir, { address: '' }).address, '', 'empty means no title');
  assert.equal(settings.readSettings(dir).address, '', 'and stays empty, not back to Captain');
  assert.equal(settings.writeSettings(dir, { address: '   ' }).address, '', 'whitespace only is empty');
  assert.equal(settings.cleanAddress('Skip\nper'), 'Skip per', 'one line');
  assert.throws(() => settings.cleanAddress('x'.repeat(41)), /40 characters/);
  assert.throws(() => settings.cleanAddress(42), /text/);
  assert.equal(settings.writeSettings(dir, {}).address, '', 'a patch without address keeps it');
  fs.writeFileSync(path.join(dir, settings.FILE), '{not json');
  assert.equal(settings.readSettings(dir).address, 'Captain', 'a broken file falls back to the default');
  assert.deepEqual(settings.suggestions('Ada Lovelace'), ['Captain', 'Boss', 'Ada', '']);
  assert.deepEqual(settings.suggestions(null), ['Captain', 'Boss', '']);
});

test('HTTP: default, change, persistence across a restart and the empty value', async (t) => {
  const home = tempHome(t);
  const ordersDir = tempDir(t, 'ship-deck-orders-');
  const before = fingerprint(home);
  let s = await startServer(t, { home, ordersDir });

  let r = await s.get('/api/settings');
  assert.equal(r.address, 'Captain');
  assert.equal(r.default, 'Captain');
  assert.deepEqual(r.suggestions, ['Captain', 'Boss', 'Ada', '']);
  assert.equal((await s.get('/api/fleet')).settings.address, 'Captain', 'the board reads it from the fleet snapshot');

  let p = await s.post({ address: 'Boss' });
  assert.equal(p.status, 200);
  assert.equal(p.data.settings.address, 'Boss');
  assert.equal(p.data.order, null, 'nothing is sent to the first mate unless asked');
  assert.equal((await s.get('/api/fleet')).settings.address, 'Boss');

  await s.close();
  s = await startServer(t, { home, ordersDir });
  assert.equal((await s.get('/api/settings')).address, 'Boss', 'persisted in the orders dir');

  p = await s.post({ address: '' });
  assert.equal(p.status, 200);
  assert.equal((await s.get('/api/fleet')).settings.address, '', 'no title');

  assert.equal((await s.post({ address: 'x'.repeat(41) })).status, 400);
  assert.equal((await s.post({})).status, 400, 'address is required');
  assert.equal((await s.post({ address: 'Boss' }, {})).status, 403, 'POST guard: X-Ship-Deck header');
  assert.equal((await s.get('/api/settings')).address, '', 'refused requests change nothing');
  assert.equal(orders.listOrders(ordersDir).length, 0);
  assert.deepEqual(fingerprint(home), before, 'the fleet home was not written');
});

test('telling the first mate: one address message, the wake line, and the orders.js reminder', async (t) => {
  const home = tempHome(t);
  const ordersDir = tempDir(t, 'ship-deck-orders-');
  const before = fingerprint(home);
  const s = await startServer(t, { home, ordersDir });

  assert.deepEqual(runCli(['list'], ordersDir).out, ['no orders'], 'default: no reminder');

  let p = await s.post({ address: 'Skipper', tell: true });
  assert.equal(p.data.order.kind, 'address');
  assert.equal(p.data.order.address, 'Skipper');
  assert.match(p.data.order.text, /call me "Skipper"/);
  const list = orders.listOrders(ordersDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'address');

  p = await s.post({ address: 'Skipper', tell: true });
  assert.equal(p.data.order, null, 'unchanged: no second message');
  p = await s.post({ address: '', tell: true });
  assert.match(p.data.order.text, /don't use a title/);
  assert.equal(p.data.order.address, '');

  const after = fingerprint(home);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  assert.deepEqual(changed, [path.join('state', 'ship-deck-inbox.status')], 'only the existing wake line under the home');
  const wakeLines = fs.readFileSync(path.join(home, 'state', 'ship-deck-inbox.status'), 'utf8').trim().split('\n');
  assert.equal(wakeLines.length, 2);
  assert.match(wakeLines[0], /^message: o-\S+ address Please call me "Skipper"/);

  let r = runCli(['list', '--pending'], ordersDir);
  assert.equal(r.out[0], 'address the captain as: no title or name, just talk to them directly (their Ship Deck setting)');
  assert.ok(r.out.some((l) => l.includes('address="Skipper"')), 'the payload shows the value');
  settings.writeSettings(ordersDir, { address: 'Boss' });
  assert.equal(runCli(['thread'], ordersDir).out[0], 'address the captain as: "Boss" (their Ship Deck setting)');
  r = runCli(['list', '--json'], ordersDir);
  assert.ok(Array.isArray(JSON.parse(r.out.join('\n'))), '--json stays a plain array');
});

test('the address kind is internal: POST /api/orders refuses it', () => {
  assert.throws(() => orders.validateOrder({ kind: 'address', address: 'Boss', text: 'x' }), /unknown order kind/);
  assert.equal(orders.validateOrder({ kind: 'address', address: ' Boss ', text: 'call me Boss' }, { internal: true }).address, 'Boss');
});
