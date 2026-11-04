'use strict';
// Delegation (scope `answer`): a teammate answers a Needs-you item for the captain. Asked for help:
// sent at once. Not asked: sent after a short window the captain can cancel. Guarded items, lost
// access and stale answers are refused; every step is an audit row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../relay/lib/delegate');
const { validateGrant } = require('../relay/lib/access');
const { sanitizeSnapshot, targetFor } = require('../relay/lib/snapshot');
const delegate = require('../lib/delegate');
const orders = require('../lib/orders');
const board = require('../public/board');
const { createServer, listen } = require('../server');
const { startRelay, snapshot } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');
const DELAY = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-deleg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('answers: a letter, a reply or both; tags and control characters out; capped', () => {
  assert.deepEqual(D.sanitizeAnswer({ ref: 'refAAAAAAAAA', letter: ' b ', text: 'Use <script>alert(1)</script>v2\u0007 please\n\n\n\nthanks' }),
    { ref: 'refAAAAAAAAA', letter: 'B', text: 'Use alert(1)v2 please\n\nthanks' });
  assert.deepEqual(D.sanitizeAnswer({ ref: 'refAAAAAAAAA', text: 'restart it' }), { ref: 'refAAAAAAAAA', letter: null, text: 'restart it' });
  assert.equal(D.sanitizeAnswer({ ref: 'refAAAAAAAAA', text: 'x'.repeat(5000) }).text.length, D.MAX_TEXT);
  for (const bad of [{ ref: 'x', text: 'a' }, { ref: 'refAAAAAAAAA', letter: 'Z' }, { ref: 'refAAAAAAAAA' }, { ref: 'refAAAAAAAAA', text: '<b></b>' }]) assert.throws(() => D.sanitizeAnswer(bad));
  assert.throws(() => validateGrant('g@keychain.com', { scopes: ['answer'], projects: ['*'] }, { domain: 'keychain.com' }), /needs the Board/);
  assert.deepEqual(validateGrant('g@keychain.com', { scopes: ['board', 'answer'], projects: ['*'] }, { domain: 'keychain.com' }).scopes, ['board', 'answer']);
  assert.equal(D.describe({ letter: 'B', text: 'x' }), 'B and a reply');
  // Guarded items: the note, the options, a queued question's hold or a (guard: ...) tag.
  assert.equal(board.guardedOf({ lastStatus: [{ note: 'Drop the prod table? This is irreversible.' }] }), true);
  assert.equal(board.guardedOf({ options: [{ letter: 'A', text: 'rotate the keys (security-sensitive)' }] }), true);
  assert.equal(board.guardedOf({ title: 'Pick a colour', tags: { guard: 'captain' } }), true);
  assert.equal(board.guardedOf({ lastStatus: [{ note: 'Keep the endpoint or drop it?' }] }), false);
  // The relay keeps queued questions only from the allow-list and finds a target for answer grants only.
  const snap = sanitizeSnapshot({ ...snapshot(), calls: [{ ref: 'refCCCCCCCCC', id: 'pick', title: 'Pick', project: null, options: [], guarded: false, secret: 'x' }], features: ['answer', 'other'] });
  assert.deepEqual(snap.features, ['answer']);
  assert.equal(snap.calls[0].secret, undefined);
  assert.equal(targetFor(snap, { scopes: ['board'], projects: ['*'] }, 'refCCCCCCCCC').refused, 'not found');
  assert.equal(targetFor(snap, { scopes: ['board', 'answer'], projects: ['harbor-app'] }, 'refCCCCCCCCC').refused, 'project not shared');
  assert.equal(targetFor(snap, { scopes: ['board', 'answer'], projects: ['*'] }, 'refCCCCCCCCC').target.kind, 'call');
});

test('orders: answeredBy and help only from the server, never from a request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-deleg-o-'));
  try {
    const ctx = { knownIds: new Set(['a-1']) };
    assert.equal(orders.validateOrder({ kind: 'decision', target: 'a-1', text: 'go', answeredBy: 'm@keychain.com' }, ctx).answeredBy, undefined);
    assert.equal(orders.validateOrder({ kind: 'decision', target: 'a-1', text: 'go' }, { ...ctx, answeredBy: 'm@keychain.com' }).answeredBy, 'm@keychain.com');
    assert.throws(() => orders.validateOrder({ kind: 'help', target: 'a-1', mate: 'm@keychain.com', text: 'dm' }, ctx), /unknown order kind/);
    const h = orders.validateOrder({ kind: 'help', target: 'a-1', mate: 'm@keychain.com', link: 'https://relay.example/#x', text: 'dm' }, { ...ctx, internal: true });
    assert.deepEqual([h.mate, h.target, h.link], ['m@keychain.com', 'a-1', 'https://relay.example/#x']);
    assert.throws(() => orders.validateOrder({ kind: 'help', mate: 'm@keychain.com', text: 'dm' }, { ...ctx, internal: true }), /worker or a queue item/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(delegate.answerText({ letter: 'B', text: 'drop it' }, 'now'), '(B) drop it\n\nnow');
  assert.equal(delegate.answerText(null, 'restart'), 'restart');
});

// The fixture home plus a failed worker and a guarded decision.
function home(dir) {
  const h = path.join(dir, 'home');
  fs.cpSync(FIX, h, { recursive: true });
  const meta = (id, project) => fs.writeFileSync(path.join(h, 'state', id + '.meta'), `window=fleet:fm-${id}\nproject=/tmp/sample/projects/${project}\nkind=ship\n`);
  meta('kappa-wipe', 'lighthouse-api');
  fs.writeFileSync(path.join(h, 'state', 'kappa-wipe.status'), 'needs-decision: drop the old tide table? This is irreversible. Options: (A) drop it; (B) keep it.\n');
  meta('iota-fail', 'harbor-app');
  fs.writeFileSync(path.join(h, 'state', 'iota-fail.status'), 'failed: the build crashed twice\n');
  return h;
}

async function startDeck(t, relay) {
  const dir = tempDir(t);
  const ordersDir = path.join(dir, 'orders');
  const server = createServer({
    home: home(dir), ordersDir, claudeDir: path.join(dir, 'claude'), memoryDir: null, tmux: false, wake: false, captainName: 'Ada',
    exec: async () => { throw new Error('nothing may run a command'); }, share: true, shareRelay: relay.base, shareNow: () => relay.clock.t, answerDelayMs: DELAY,
  });
  const port = await listen(server, 0);
  t.after(() => server.close());
  const call = async (method, p, body, headers = { 'X-Ship-Deck': '1' }) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const ordersFile = path.join(ordersDir, 'orders.jsonl');
  const list = () => (fs.existsSync(ordersFile) ? fs.readFileSync(ordersFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { call, orders: list, agent: server.shareAgent };
}

test('end to end: guards, unasked answers wait 5 s and can be cancelled, asked ones go at once', async (t) => {
  const relay = await startRelay(t);
  const adaP = await relay.person('ada@keychain.com');
  const grace = await relay.person('grace@keychain.com');
  const sam = await relay.person('sam@keychain.com');
  const ada = await startDeck(t, relay);
  await ada.call('POST', '/api/share/signin', { email: adaP.email, password: adaP.password });
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'answer'], projects: ['*'] });
  await ada.call('POST', '/api/share/grant', { email: 'sam@keychain.com', scopes: ['board', 'suggest'], projects: ['*'] });
  assert.equal(await ada.agent.tick(), 'pushed');
  const sub = (await relay.store.cmd(['SCAN', '0', 'MATCH', 'snap:*']))[1][0].slice(5);
  const gb = (await grace.call('GET', `/v1/decks/${sub}/board`)).data;
  assert.deepEqual(gb.features, ['answer']);
  assert.equal(gb.help, '0', 'an answer grant learns its help version on the board read');
  const byId = (id) => gb.workers.find((w) => w.id === id);
  const call = gb.calls.find((c) => c.id === 'pick-beacon-color');
  assert.ok(call && byId('kappa-wipe').guarded && !byId('gamma-decision').guarded);
  assert.equal((await sam.call('GET', `/v1/decks/${sub}/board`)).data.calls, undefined, 'queued questions only for answer grants');
  const answer = (who, body, headers) => who.call('POST', `/v1/decks/${sub}/answers`, body, headers);
  const fleet = async () => (await ada.call('GET', '/api/fleet')).data;
  const sync = async () => { relay.clock.t += 61e3; return ada.agent.syncAnswers(); };
  const mine = async () => (await grace.call('GET', `/v1/decks/${sub}/answers`)).data.answers;

  // Guards: no scope, cross-site, guarded, not waiting, an option not offered.
  assert.equal((await answer(sam, { ref: byId('delta-block').ref, text: 'x' })).status, 403);
  assert.equal((await answer(grace, { ref: byId('delta-block').ref, text: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  let r = await answer(grace, { ref: byId('kappa-wipe').ref, letter: 'B' });
  assert.deepEqual([r.status, r.data.error], [403, 'only the captain can answer this']);
  assert.equal((await answer(grace, { ref: byId('alpha-fix').ref, text: 'x' })).status, 400);
  assert.equal((await answer(grace, { ref: byId('gamma-decision').ref, letter: 'H' })).status, 400);
  assert.equal(ada.orders().length, 0);

  // Not asked: the deck shows it counting down, then sends it with who answered.
  r = await answer(grace, { ref: byId('delta-block').ref, text: 'Restart the staging db, then retry' });
  assert.deepEqual([r.status, r.data.answer.asked], [200, false]);
  assert.equal(await sync(), 'fetched');
  await sleep(50);
  let f = await fleet();
  assert.deepEqual(f.delegation.waiting.map((w) => [w.taskId, w.by, w.text]), [['delta-block', 'grace@keychain.com', 'Restart the staging db, then retry']]);
  assert.ok(f.delegation.waiting[0].dueAt > Date.now());
  assert.equal(ada.orders().length, 0, 'nothing goes before the window ends');
  await sleep(DELAY + 150);
  let o = ada.orders();
  assert.deepEqual(o.map((x) => [x.kind, x.target, x.text, x.answeredBy]), [['decision', 'delta-block', 'Restart the staging db, then retry', 'grace@keychain.com']]);
  assert.equal((await fleet()).orders.list.find((x) => x.target === 'delta-block').answeredBy, 'grace@keychain.com', 'listed with who answered');
  assert.deepEqual((await mine()).map((a) => a.state), ['sent']);
  f = await fleet();
  assert.deepEqual(f.delegation.recent.map((x) => [x.state, x.taskId]), [['sent', 'delta-block']]);

  // Not asked, cancelled in the window: nothing is sent, the teammate sees it was cancelled.
  r = await answer(grace, { ref: byId('gamma-decision').ref, letter: 'B', text: 'v2 is ready' });
  await sync();
  await sleep(50);
  const id = (await fleet()).delegation.waiting[0].id;
  assert.equal((await ada.call('POST', '/api/share/answer', { id, action: 'cancel' }, {})).status, 403, 'the usual guards');
  assert.equal((await ada.call('POST', '/api/share/answer', { id, action: 'cancel' })).status, 200);
  await sleep(DELAY + 100);
  assert.equal(ada.orders().length, 1);
  assert.equal((await mine()).find((a) => a.id === id).state, 'cancelled');
  assert.equal((await ada.call('POST', '/api/share/answer', { id, action: 'cancel' })).status, 400, 'once');

  // Lost access inside the window: refused when it would have gone.
  r = await answer(grace, { ref: byId('iota-fail').ref, text: 'rerun with --verbose' });
  await sync();
  await sleep(50);
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board'], projects: ['*'] });
  await sleep(DELAY + 150);
  assert.equal(ada.orders().length, 1);
  assert.equal((await relay.store.cmd(['HGETALL', 'ans:' + sub])).filter((v) => /"refused"/.test(v)).length, 1);
  await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['board', 'answer'], projects: ['*'] });

  // Ask for help: not for a guarded item or someone without answer; then a help order for the
  // first mate (Slack DM) and a notice on the teammate's page.
  assert.equal((await ada.call('POST', '/api/share/help', { target: 'kappa-wipe', email: 'grace@keychain.com' })).status, 400);
  assert.equal((await ada.call('POST', '/api/share/help', { target: 'gamma-decision', email: 'sam@keychain.com' })).status, 400);
  r = await ada.call('POST', '/api/share/help', { item: 'pick-beacon-color', email: 'grace@keychain.com' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const help = ada.orders().find((x) => x.kind === 'help');
  assert.deepEqual([help.item, help.mate], ['pick-beacon-color', 'grace@keychain.com']);
  assert.equal(orders.listOrders((await fleet()).orders.dir).find((x) => x.kind === 'help').mate, 'grace@keychain.com');
  assert.match(help.text, /^Please DM grace@keychain.com on Slack: Ada asked them for help with "Choose the beacon color for night mode"/);
  assert.ok(help.text.includes(relay.base + '/#' + sub));
  f = await fleet();
  assert.deepEqual(f.delegation.help.map((x) => [x.itemId, x.email, x.slack]), [['pick-beacon-color', 'grace@keychain.com', 'pending']]);
  orders.ackOrder(f.orders.dir, help.id, 'declined', 'no Slack here');
  assert.equal((await fleet()).delegation.help[0].slack, 'declined', 'the board can hint to connect Slack');
  const gh = (await grace.call('GET', '/v1/me/help')).data;
  assert.deepEqual(gh.help.map((x) => [x.captainSub, x.ref, x.title]), [[sub, call.ref, 'Choose the beacon color for night mode']]);
  assert.equal((await grace.call('GET', '/v1/me/help?since=' + gh.version)).data.same, true);
  assert.notEqual((await grace.call('GET', `/v1/decks/${sub}/board`)).data.help, '0');

  // Asked: sent at once, as the queue answer, and the help request closes.
  r = await answer(grace, { ref: call.ref, text: 'Teal, it reads best at night' });
  assert.deepEqual([r.status, r.data.answer.asked], [200, true]);
  relay.clock.t += 21e3;
  assert.equal(await ada.agent.syncAnswers(), 'fetched');
  await sleep(100);
  o = ada.orders().filter((x) => x.kind === 'backlog-answer');
  assert.deepEqual(o.map((x) => [x.item, x.text, x.answeredBy]), [['pick-beacon-color', 'Teal, it reads best at night', 'grace@keychain.com']]);
  assert.equal((await fleet()).delegation.help.length, 0);
  assert.deepEqual((await grace.call('GET', '/v1/me/help')).data.help, []);

  // Audit: every step.
  const log = (await ada.call('GET', '/api/share/audit')).data.rows.map((x) => [x.result, x.what]);
  for (const [res, what] of [
    ['answered', `Answered a reply for "${byId('delta-block').title}"`],
    ['sent', `Sent grace@keychain.com's answer a reply for "${byId('delta-block').title}"`],
    ['cancelled', `Cancelled grace@keychain.com's answer B and a reply for "${byId('gamma-decision').title}"`],
    ['refused', `Did not send grace@keychain.com's answer a reply for "${byId('iota-fail').title}"`],
    ['asked', 'Asked grace@keychain.com for help with "Choose the beacon color for night mode"'],
    ['answered', 'Answered a reply for "Choose the beacon color for night mode" (asked for help)'],
  ]) assert.ok(log.some(([a, b]) => a === res && b === what), `${res}: ${what}`);
  assert.ok(log.some(([a, b]) => a === 'refused' && b === `Answer for "${byId('kappa-wipe').title}"`));
});

test('backward compatible: a deck that does not take answers refuses them; an old deck never polls', async (t) => {
  const relay = await startRelay(t);
  const ada = await relay.captain();
  const grace = await relay.person('grace@keychain.com');
  await relay.deckCall(ada.token, 'PUT', '/v1/grants/grace%40keychain.com', { scopes: ['board', 'answer'], projects: ['*'] });
  await relay.deckCall(ada.token, 'POST', '/v1/snapshot', snapshot());
  const r = await grace.call('POST', `/v1/decks/${ada.sub}/answers`, { ref: 'refBBBBBBBBB', letter: 'A' });
  assert.deepEqual([r.status, r.data.error], [409, 'their Ship Deck needs an update before you can answer for them']);
  // Unchanged answer lists cost only the deck auth.
  const v = (await relay.deckCall(ada.token, 'GET', '/v1/answers')).data.version;
  const n = relay.store.stats.commands;
  assert.equal((await relay.deckCall(ada.token, 'GET', '/v1/answers?since=' + v)).data.same, true);
  assert.equal(relay.store.stats.commands - n, 1);
});
