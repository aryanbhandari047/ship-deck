'use strict';
// Read-only sharing, deck side: the allow-list projection, redaction of known secret shapes, caps,
// worker refs, grant unions, the share agent's push/backoff pacing, and the copies the relay keeps
// of the deck's allow-list and UI files. Fixture data and fake relays only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSnapshot } = require('../lib/fleet');
const share = require('../lib/share');
const { redact, stripAnsi } = require('../lib/redact');
const relaySnap = require('../relay/lib/snapshot');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'home');
const HOME = '/Users/ada';
const FORBIDDEN_KEYS = ['home', 'worktree', 'projectPath', 'window', 'session', 'sessionId', 'resume', 'cwd', 'files', 'orders', 'thread', 'prHead', 'attachments', 'attachment', 'homeLabel', 'firstmate', 'backlog', 'configOptions', 'path', 'brief', 'alive', 'harness', 'kind', 'mode'];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-share-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}
function stringsDeep(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsDeep(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsDeep(x, out));
  return out;
}

// The /api/fleet object as server.js builds it, decorated with everything that must never leave.
async function richFleet() {
  const snap = await buildSnapshot(FIX, { tmux: false, now: Date.parse('2026-01-06T00:00:00Z') });
  snap.orders = { dir: HOME + '/.ship-deck', list: [{ id: 'o-1', text: 'secret order', attachments: [{ id: 'a-1' }] }] };
  snap.thread = { sig: 'x', lastReplyId: 'r-1' };
  snap.homeLabel = '~/firstmate';
  snap.firstmate = { session: { sessionId: 'f5c1-uuid', resume: `cd '${HOME}/firstmate' && claude --resume f5c1-uuid` } };
  for (const t of snap.tasks) {
    t.session = { sessionId: 'uuid-' + t.id, cwd: HOME + '/wt/' + t.id, resume: 'claude --resume uuid-' + t.id };
    t.config = { harness: 'claude', model: 'opus', effort: 'high' };
    t.files = ['brief.md', 'report.md'];
  }
  return snap;
}
const ALL = { scopes: share.SCOPES, projects: ['*'] };
const EXTRAS = {
  firstMate: { state: 'working', since: 1 },
  terminal: { 'alpha-fix': { at: 1, text: '\x1b[31mFAIL\x1b[0m token=abc123def\nAKIAABCDEFGHIJKLMNOP\n' + 'line\n'.repeat(80) } },
  skills: [{ key: 'skill:captain:deploy', title: 'Deploy', description: 'Reads /Users/ada/secrets.env', path: HOME + '/.claude/skills/deploy/SKILL.md' }],
  notes: [{ key: 'home:data/captain.md', title: "Captain's preferences", text: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for CI', path: HOME + '/firstmate/data/captain.md' }],
  thread: [{ type: 'order', ts: '2026-01-05T10:00:00Z', text: 'look at /Users/ada/code/x', attachments: [{ id: 'att-1', name: 'shot.png' }] }, { type: 'reply', ts: '2026-01-05T10:01:00Z', text: 'done' }],
  activity: [{ ts: 1, label: 'Editing app.js', detail: 'cat ~/.aws/credentials', icon: 'edit' }],
};

test('projection never emits home, paths, windows, sessions, files, orders, thread or attachments, whatever the toggles', async () => {
  const fleet = await richFleet();
  const combos = [[], ['board'], ['board', 'updates', 'model'], share.SCOPES];
  for (const scopes of combos) {
    for (const projects of [['*'], ['harbor-app'], []]) {
      const out = share.projectSnapshot(fleet, { scopes, projects, key: 'k', home: HOME, extras: EXTRAS, now: Date.parse('2026-01-06T00:00:00Z') });
      const keys = keysDeep(out);
      for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `${k} leaked with ${scopes}/${projects}`);
      for (const k of Object.keys(out)) assert.ok(share.SNAPSHOT_KEYS.includes(k), 'snapshot key ' + k);
      for (const w of out.workers) for (const k of Object.keys(w)) assert.ok(share.WORKER_KEYS.includes(k), 'worker key ' + k);
      const text = stringsDeep(out).join('\n');
      for (const bad of [HOME, '/tmp/sample', 'fm-alpha-fix', 'uuid-', 'secret order', 'att-1', 'shot.png', 'f5c1', '0123456789abcdef0123456789abcdef01234567']) {
        assert.ok(!text.includes(bad), `${bad} leaked with ${scopes}/${projects}`);
      }
      if (!projects.length) assert.equal(out.workers.length, 0, 'no projects: default deny');
    }
  }
});

test('projection: optional sections only with their scope; projects filter and hidden count', async () => {
  const fleet = await richFleet();
  const base = share.projectSnapshot(fleet, { scopes: ['board'], projects: ['harbor-app'], key: 'k', home: HOME, extras: EXTRAS });
  for (const k of ['updates', 'terminal', 'skills', 'notes', 'chat', 'activity']) assert.equal(base[k], undefined, k);
  assert.ok(base.workers.every((w) => w.project === 'harbor-app'));
  assert.ok(base.hiddenProjects >= 1);
  assert.ok(base.workers.every((w) => w.model === undefined), 'model only with the model scope');
  assert.ok(!base.workers.some((w) => w.id === 'north-mate'), 'second mates are not workers on the board');
  const full = share.projectSnapshot(fleet, { ...ALL, key: 'k', home: HOME, extras: EXTRAS });
  const alpha = full.workers.find((w) => w.id === 'alpha-fix');
  assert.deepEqual(alpha.pr, { number: 42, url: 'https://github.com/example-org/harbor-app/pull/42', ci: null });
  assert.equal(alpha.model, 'opus');
  const term = full.terminal[alpha.ref];
  assert.ok(term.lines.length <= 40);
  assert.ok(!term.lines.join('\n').includes('\x1b'), 'ANSI stripped');
  assert.ok(!term.lines.join('\n').includes('AKIA'), 'terminal redacted');
  assert.equal(full.skills[0].description, 'Reads ~/secrets.env');
  assert.ok(!full.notes[0].text.includes('ghp_'));
  assert.equal(full.chat.length, 2);
  assert.deepEqual(Object.keys(full.activity[0]).sort(), ['label', 'ts']);
});

test('worker refs are HMACs: stable per key, different across keys, never the id', () => {
  const a = share.workerRef('key-1', 'alpha-fix');
  assert.equal(a, share.workerRef('key-1', 'alpha-fix'));
  assert.notEqual(a, share.workerRef('key-2', 'alpha-fix'));
  assert.ok(!a.includes('alpha'));
  assert.match(a, relaySnap.REF_RE);
});

const SECRETS = [
  ['GitHub token', 'pushed with ghp_1234567890abcdefghijABCDEFGHIJ123456', 'ghp_1234567890'],
  ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github_pat_11'],
  ['OAuth', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', 'gho_abc'],
  ['Slack', 'xoxb-1234567890-0987654321-AbCdEfGhIjKl', 'xoxb-'],
  ['AWS key id', 'AWS_ACCESS_KEY_ID AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['AWS secret', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['AWS secret bare', 'secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok', 'wJalrXUtnFEMI'],
  ['OpenAI', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwx1234', 'sk-proj-abc'],
  ['Anthropic', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'sk-ant-api03'],
  ['JWT', 'cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGciOiJIUzI1NiJ9'],
  ['PEM', 'key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAC3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----\nafter', 'b3BlbnNzaC1rZXktdjEAAAAA'],
  ['PEM unterminated', 'oops -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z', 'MIIEpAIBAAKCAQEA0Z'],
  ['Bearer', 'curl -H "Authorization: Bearer abc.def.ghi-jkl_mno" https://api.example.com', 'abc.def.ghi'],
  ['bearer bare', 'use bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0', '9f8e7d6c5b4a'],
  ['password=', 'DATABASE password=hunter2!! ok', 'hunter2'],
  ['password: quoted', 'password: "correct horse battery"', 'correct horse'],
  ['token=', 'retry with token=abc123 now', 'abc123'],
  ['secret=', 'CLIENT_SECRET=s3cr3t-value-here', 's3cr3t'],
  ['api key', 'api_key: AbC123xyz', 'AbC123xyz'],
  ['Stripe', 'sk_live_51HabcdefGHIJKLmnopQRSTuv', 'sk_live_51H'],
  ['Google API', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz12345', 'AIzaSyA-abc'],
  ['high entropy', 'value 8f14e45fceea167a5a36dedd4bea2543a1b2c3d4 end', '8f14e45fceea'],
  ['high entropy b64', 'blob Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u end', 'Zm9vYmFyYmF6'],
  ['URL query', 'see https://github.com/o/r/pull/4?token=SECRETQ#frag', 'SECRETQ'],
  ['URL fragment', 'see https://github.com/o/r#access_token=FRAGSECRET', 'FRAGSECRET'],
  ['URL userinfo', 'clone https://user:pa55w0rd@github.com/o/r.git', 'pa55w0rd'],
  ['other host', 'dashboard https://grafana.internal.example/d/abc?org=1', 'grafana.internal'],
  ['home path', 'edited /Users/ada/code/app/server.js', '/Users/ada'],
  ['other abs path', 'wrote /var/folders/xy/T/tmp123/out.log', '/var/folders'],
  ['other user', 'see /Users/bob/notes.txt', '/Users/bob'],
  ['two segments', 'check /opt2/srv/config.yml', '/opt2/srv'],
  ['windows path', 'C:\\Users\\ada\\secrets.txt', 'C:\\Users'],
  ['file url', 'open file:///Users/ada/x.html', 'file://'],
];

test('redaction removes every known secret shape', () => {
  for (const [name, input, secret] of SECRETS) {
    const out = redact(input, { home: HOME });
    assert.ok(!out.includes(secret), `${name}: ${JSON.stringify(out)}`);
  }
});

test('redaction keeps ordinary text, allowed links and the home as ~', () => {
  const cases = [
    ['PR 42 opened, waiting on CI.', 'PR 42 opened, waiting on CI.'],
    ['see https://github.com/o/r/pull/42?x=1.', 'see https://github.com/o/r/pull/42.'],
    ['edited /Users/ada/code/app.js', 'edited ~/code/app.js'],
    ['dashboard https://evil.example/x', 'dashboard [link hidden]'],
    ['GET /health returned 200', 'GET /health returned 200'],
    ['and/or 1/2', 'and/or 1/2'],
    ['\x1b[32mgreen\x1b[0m and \x1b]8;;http://x\x07link\x1b]8;;\x07', 'green and link'],
  ];
  for (const [input, want] of cases) assert.equal(redact(input, { home: HOME }), want);
  assert.equal(stripAnsi('a\x07b\x00c\r\nd'), 'abc\nd');
  assert.equal(redact('[path hidden] stays', { home: HOME }), '[path hidden] stays');
});

test('caps: 200 chars per summary, 40 terminal lines, 64 KB per snapshot', async () => {
  const fleet = await richFleet();
  const alpha = fleet.tasks.find((t) => t.id === 'alpha-fix');
  alpha.lastStatus.push({ state: 'working', note: 'word '.repeat(400) });
  alpha.options = [{ letter: 'A', text: 'x '.repeat(500) }];
  const many = Array.from({ length: 400 }, (_, i) => ({ ...alpha, id: 'w' + i, title: 'T'.repeat(300) }));
  const huge = { ...fleet, tasks: [...fleet.tasks, ...many] };
  const extras = { ...EXTRAS, notes: Array.from({ length: 20 }, (_, i) => ({ key: 'n' + i, title: 'n', text: 'note '.repeat(5000) })) };
  const out = share.projectSnapshot(huge, { ...ALL, key: 'k', home: HOME, extras });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 64 * 1024);
  assert.ok(out.trimmed.includes('notes'));
  for (const w of out.workers) {
    assert.ok(w.summary.length <= 200);
    assert.ok(w.title.length <= 120);
    for (const o of w.options) assert.ok(o.text.length <= 200);
  }
  const small = share.projectSnapshot(fleet, { ...ALL, key: 'k', home: HOME, extras: EXTRAS });
  for (const t of Object.values(small.terminal)) assert.ok(t.lines.length <= 40);
});

test('notes over 64 KB are shortened, not dropped: every key and title stays', async () => {
  const fleet = await richFleet();
  const notes = Array.from({ length: 36 }, (_, i) => ({ key: 'memory:n' + i + '.md', title: 'Note ' + i, text: 'rule '.repeat(1600) }));
  const out = share.projectSnapshot(fleet, { ...ALL, key: 'k', home: HOME, extras: { ...EXTRAS, notes } });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 64 * 1024);
  assert.ok(!out.trimmed.includes('notes'));
  assert.deepEqual(out.notes.map((n) => [n.key, n.title]), notes.map((n) => [n.key, n.title]));
  for (const n of out.notes) assert.ok(n.shortened && n.text.length > 0 && n.text.length < 8000);
  const one = share.projectSnapshot(fleet, { ...ALL, key: 'k', home: HOME, extras: { ...EXTRAS, notes: notes.slice(0, 1) } });
  assert.equal(one.notes[0].shortened, undefined);
});

test('grant union: expired grants drop out; no grants means nothing to send', () => {
  const now = 1000;
  assert.deepEqual(share.unionOf([], now), { count: 0, scopes: [], projects: [] });
  const u = share.unionOf([
    { scopes: ['board'], projects: ['a'], expiresAt: 2000 },
    { scopes: ['terminal'], projects: ['b'], expiresAt: 999 },
    { scopes: ['updates', 'attachments'], projects: ['c'], expiresAt: 5000 },
  ], now);
  assert.deepEqual(u, { count: 2, scopes: ['board', 'updates'], projects: ['a', 'c'] });
  assert.deepEqual(share.unionOf([{ scopes: ['board'], projects: ['*', 'a'], expiresAt: 2000 }], now).projects, ['*']);
});

test('the deck side cannot reach orders or fm-send: share and redact require only built-ins and pure modules', () => {
  for (const f of ['lib/share.js', 'lib/redact.js', 'lib/knowledge.js', 'lib/library.js', 'lib/usage.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of reqs) assert.ok(r.startsWith('node:') || ['../public/board', './redact', './knowledge', './library', './usage'].includes(r), `${f} requires ${r}`);
    const code = src.replace(/^\s*\/\/.*$/gm, ''); // comments may name what is out of reach
    assert.ok(!/fm-send|sendMessage|createOrder|execFile|child_process/.test(code), f + ' mentions a command path');
  }
});

test('the relay keeps the same allow-list, and its UI copies match the deck', () => {
  assert.deepEqual(relaySnap.WORKER_KEYS, share.WORKER_KEYS);
  assert.deepEqual(relaySnap.SNAPSHOT_KEYS, share.SNAPSHOT_KEYS);
  assert.deepEqual(relaySnap.SCOPES, share.SCOPES);
  const relayLib = require('../relay/lib/library');
  assert.deepEqual(relayLib.ITEM_KEYS, share.LIBRARY_ITEM_KEYS);
  assert.equal(relayLib.KEY_RE.source, share.LIBRARY_KEY_RE.source);
  assert.equal(relayLib.MAX_TEXT, share.LIMITS.libraryText);
  assert.equal(share.LIMITS.library, 512 * 1024);
  assert.equal(relayLib.MAX_BYTES, share.LIMITS.library, 'the relay takes the largest library a deck sends');
  for (const f of require('../relay/scripts/sync-ui.js').FILES) {
    assert.equal(fs.readFileSync(path.join(ROOT, 'relay/public', f), 'utf8'), fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), `relay/public/${f} drifted: run node relay/scripts/sync-ui.js`);
  }
  const symbols = (f) => new Map([...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/<symbol id="([^"]+)"[\s\S]*?<\/symbol>/g)].map((m) => [m[1], m[0]]));
  const deck = symbols('public/index.html');
  for (const f of ['public/share.html', 'public/settings.html', 'relay/public/index.html', 'relay/public/invite.html']) {
    for (const [id, svg] of symbols(f)) assert.equal(svg, deck.get(id), `${f} #${id} differs from public/index.html`);
  }
});

test('relay sanitizer drops anything outside the allow-list, even from a forged push', () => {
  const forged = {
    v: 1, home: HOME, scopes: ['board', 'attachments'], projects: ['*'], fleet: { counts: { needs: 1 }, firstMate: { state: 'working', since: 1, cwd: HOME }, monitoring: 'ok', window: 'x' },
    workers: [{ ref: 'abcdefgh12345678', id: 'a', title: 't', project: 'p', state: 'working', quietDays: null, summary: 's', updatedAt: 1, options: [{ letter: 'A', text: 'x', path: HOME }], pr: { number: 1, url: 'https://evil.example/x', head: 'abc' }, worktree: HOME, session: 'uuid', window: 'fleet:x' }],
    terminal: { abcdefgh12345678: { at: 1, lines: ['ok'], window: 'x' }, unknownref1234567: { lines: ['leak'] } },
    orders: [1], thread: {}, attachments: [],
  };
  const s = relaySnap.sanitizeSnapshot(forged, 5);
  const keys = keysDeep(s);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), k);
  assert.deepEqual(s.scopes, ['board']);
  assert.equal(s.workers[0].pr.url, null);
  assert.deepEqual(Object.keys(s.terminal), ['abcdefgh12345678']);
  assert.throws(() => relaySnap.sanitizeSnapshot({ v: 2 }), /unsupported/);
});

// ---------- the share agent ----------

function fakeRelay({ grants = [{ viewerEmail: 'grace@keychain.com', scopes: ['board'], projects: ['*'], expiresAt: Date.now() + 86400e3 }] } = {}) {
  const calls = [];
  let fail = null;
  const fetchImpl = async (url, opts) => {
    const p = new URL(url).pathname;
    calls.push({ method: opts.method, path: p, auth: opts.headers.Authorization || null, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (fail) return reply(fail.status, { error: fail.error }, fail.headers);
    if (p === '/v1/device/login') return reply(200, { token: 'sdt1.test', account: { sub: 'ada-sub', email: 'ada@keychain.com', name: 'Ada' } });
    if (p === '/v1/grants' || p.startsWith('/v1/grants/')) return reply(200, { grants });
    if (p === '/v1/snapshot') return reply(200, { ok: true, grants });
    if (p === '/v1/library') return reply(200, { ok: true });
    return reply(404, { error: 'not found' });
  };
  return { fetchImpl, calls, setFail: (f) => { fail = f; } };
}

async function makeAgent(t, relay, clock) {
  const dir = tempDir(t);
  const fleet = await richFleet();
  const agent = share.createShareAgent({
    relayUrl: 'https://relay.example', dir, home: HOME, fetchImpl: relay.fetchImpl, now: () => clock.t,
    readFleet: async () => fleet, readTerminal: async () => 'pane', readExtras: async () => ({ firstMateWorking: false }),
  });
  return { agent, fleet, dir };
}

test('agent: default deny, then pushes on change only, at most every 30 s, with a 10-minute keep-alive', async (t) => {
  const clock = { t: 1e12 };
  const relay = fakeRelay();
  const { agent, fleet, dir } = await makeAgent(t, relay, clock);
  assert.equal(await agent.tick(), 'off', 'not signed in: nothing is sent');
  assert.equal(relay.calls.length, 0);
  await agent.signIn({ email: 'ada@keychain.com', password: 'correct horse battery' });
  const state = JSON.parse(fs.readFileSync(path.join(dir, share.STATE_FILE), 'utf8'));
  assert.ok(!JSON.stringify(state).includes('correct horse'), 'the password is never stored');
  assert.equal(fs.statSync(path.join(dir, share.STATE_FILE)).mode & 0o777, 0o600);
  assert.equal(await agent.tick(), 'pushed');
  const pushes = () => relay.calls.filter((c) => c.path === '/v1/snapshot').length;
  assert.equal(pushes(), 1);
  clock.t += 10e3;
  assert.equal(await agent.tick(), 'wait');
  clock.t += 25e3;
  assert.equal(await agent.tick(), 'same', 'unchanged: no push');
  fleet.tasks[0].title = 'A new title';
  clock.t += 1e3;
  assert.equal(await agent.tick(), 'pushed', 'changed after 30 s: push');
  fleet.tasks[0].title = 'Another title';
  clock.t += 5e3;
  assert.equal(await agent.tick(), 'wait', 'changed within 30 s: waits');
  clock.t += 30e3;
  assert.equal(await agent.tick(), 'pushed');
  clock.t += 9 * 60e3;
  assert.equal(await agent.tick(), 'same');
  clock.t += 61e3;
  assert.equal(await agent.tick(), 'pushed', 'keep-alive after 10 minutes');
  assert.equal(pushes(), 4);
  assert.ok(relay.calls.every((c) => c.path === '/v1/device/login' || c.auth === 'Bearer sdt1.test'));
});

test('agent: no active grants, nothing leaves the laptop', async (t) => {
  const clock = { t: 1e12 };
  const relay = fakeRelay({ grants: [{ viewerEmail: 'g@keychain.com', scopes: ['board'], projects: ['*'], expiresAt: 1 }] });
  const { agent } = await makeAgent(t, relay, clock);
  await agent.signIn({ email: 'ada@keychain.com', password: 'pw' });
  assert.equal(await agent.tick(), 'idle');
  assert.equal(relay.calls.filter((c) => c.path === '/v1/snapshot').length, 0);
});

test('agent: quota and outage errors back off exponentially up to 15 minutes and say "Sharing paused"', async (t) => {
  const clock = { t: 1e12 };
  const relay = fakeRelay();
  const { agent } = await makeAgent(t, relay, clock);
  await agent.signIn({ email: 'ada@keychain.com', password: 'pw' });
  relay.setFail({ status: 503, error: 'quota' });
  const waits = [];
  for (let i = 0; i < 8; i++) {
    const before = relay.calls.length;
    assert.equal(await agent.tick(), 'error');
    assert.equal(relay.calls.length, before + 1, 'one request per attempt');
    const st = agent.status();
    assert.equal(st.state, 'backoff');
    assert.match(st.problem, /^Sharing paused/);
    waits.push(st.retryAt - clock.t);
    assert.equal(await agent.tick(), 'backoff', 'no request while backing off');
    assert.equal(relay.calls.length, before + 1);
    clock.t = st.retryAt;
  }
  assert.deepEqual(waits.slice(0, 5), [30e3, 60e3, 120e3, 240e3, 480e3]);
  assert.ok(waits.every((w) => w <= 15 * 60e3));
  assert.equal(waits[7], 15 * 60e3);
  relay.setFail({ status: 429, error: 'slow down', headers: { 'retry-after': '600' } });
  await agent.tick();
  relay.setFail(null);
  clock.t = agent.status().retryAt;
  assert.equal(await agent.tick(), 'pushed');
  assert.equal(agent.status().problem, null);
});

test('agent: a relay 401 signs the deck out instead of retrying', async (t) => {
  const clock = { t: 1e12 };
  const relay = fakeRelay();
  const { agent, dir } = await makeAgent(t, relay, clock);
  await agent.signIn({ email: 'ada@keychain.com', password: 'pw' });
  relay.setFail({ status: 401, error: 'this device was signed out' });
  assert.equal(await agent.tick(), 'error');
  assert.equal(agent.status().state, 'signed-out');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, share.STATE_FILE), 'utf8')).token, undefined);
  const n = relay.calls.length;
  assert.equal(await agent.tick(), 'off');
  assert.equal(relay.calls.length, n);
});

test('agent: grant input is checked locally and relay answers are treated as data', async (t) => {
  const clock = { t: 1e12 };
  const relay = fakeRelay({ grants: [{ viewerEmail: 'g@keychain.com', scopes: ['board', 'sending', '<img>'], projects: ['*'], expiresAt: 2e12, extra: 'x', __proto__: { y: 1 } }] });
  const { agent } = await makeAgent(t, relay, clock);
  await assert.rejects(agent.putGrant({ email: 'g@keychain.com' }), /sign in/);
  await agent.signIn({ email: 'ada@keychain.com', password: 'pw' });
  await assert.rejects(agent.putGrant({ email: 'g@gmail.com', projects: ['*'] }), /keychain\.com/);
  await assert.rejects(agent.putGrant({ email: 'g@keychain.com.evil.io', projects: ['*'] }), /keychain\.com/);
  await assert.rejects(agent.putGrant({ email: 'g@keychain.com', scopes: ['attachments'], projects: ['*'] }), /at least one thing/);
  await assert.rejects(agent.putGrant({ email: 'g@keychain.com', projects: [] }), /at least one project/);
  const list = await agent.putGrant({ email: 'G@Keychain.com', projects: ['*'], days: 365 });
  const put = relay.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/v1/grants/g%40keychain.com');
  assert.deepEqual(put.body.scopes, share.DEFAULT_SCOPES, 'defaults: Board, Updates, Model');
  assert.ok(put.body.expiresAt <= clock.t + 30 * 86400e3, 'at most 30 days');
  assert.deepEqual(list[0].scopes, ['board']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'expiresAt', 'hasAccount', 'lastViewed', 'projects', 'scopes', 'viewerEmail', 'viewerName']);
});

test('share flags: off by default; --share needs an https relay', () => {
  const { parseArgs } = require('../server');
  const env = {};
  assert.equal(parseArgs(['--home', FIX], { env }).share, false);
  const o = parseArgs(['--home', FIX, '--share', '--share-relay', 'https://relay.example/x'], { env });
  assert.equal(o.share, true);
  assert.equal(o.shareRelay, 'https://relay.example');
  // The installed launcher sets SHIP_DECK_SHARE; --no-share skips sharing for one run.
  assert.equal(parseArgs(['--home', FIX, '--no-share'], { env: { SHIP_DECK_SHARE: '1', SHIP_DECK_RELAY: 'https://relay.example' } }).share, false);
  assert.throws(() => share.checkRelayUrl('http://relay.example'), /https/);
  assert.equal(share.checkRelayUrl('http://localhost:3000'), 'http://localhost:3000');
});

test('push hash ignores the build time and the first mate busy flag, not real changes', () => {
  const a = { v: 1, at: 1, workers: [{ ref: 'r', title: 'x' }], fleet: { counts: {}, firstMate: { state: 'idle', since: 1 }, monitoring: 'ok' } };
  const same = { ...a, at: 2, fleet: { ...a.fleet, firstMate: { state: 'working', since: 5 } } };
  assert.equal(share.snapshotHash(a), share.snapshotHash(same));
  assert.notEqual(share.snapshotHash(a), share.snapshotHash({ ...a, fleet: { ...a.fleet, monitoring: 'late' } }));
  assert.notEqual(share.snapshotHash(a), share.snapshotHash({ ...a, workers: [{ ref: 'r', title: 'y' }] }));
});

// ---------- knowledge library (scopes skills and notes) ----------

const LIBRARY = [
  { key: 'skill:captain:deploy', title: 'Deploy', description: 'Reads /Users/ada/secrets.env', text: `# Deploy\nexport GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsee ${HOME}/firstmate/AGENTS.md and https://example.com/x?token=1\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nkey sdak1.abcdefgh12.${'Q'.repeat(43)}`, path: HOME + '/.claude/skills/deploy/SKILL.md' },
  { key: 'memory:fleet-habits.md', title: 'Fleet habits', description: '', text: 'password=hunter2hunter2' },
  { key: '/etc/passwd', title: 'bad', text: 'root' },
];

test('library projection: skills unless off, notes only when on, redacted, allow-listed, capped', () => {
  const off = share.projectLibrary(LIBRARY, { home: HOME });
  assert.deepEqual(off.items.map((i) => i.key), ['skill:captain:deploy']);
  assert.deepEqual(share.projectLibrary(LIBRARY, { home: HOME, skills: false, notes: true }).items.map((i) => i.key), ['memory:fleet-habits.md']);
  const on = share.projectLibrary(LIBRARY, { home: HOME, notes: true });
  assert.deepEqual(on.items.map((i) => i.key), ['skill:captain:deploy', 'memory:fleet-habits.md']);
  for (const it of on.items) assert.deepEqual(Object.keys(it), share.LIBRARY_ITEM_KEYS);
  const text = stringsDeep(on).join('\n');
  for (const bad of [HOME, '/Users/ada', 'ghp_', 'hunter2', 'BEGIN PRIVATE', 'example.com', 'sdak1.', 'Q'.repeat(43)]) assert.ok(!text.includes(bad), bad + ' leaked');
  assert.match(on.items[0].text, /\[token hidden\]/);
  assert.match(on.items[0].text, /\[key hidden\]/);
  const big = share.projectLibrary(Array.from({ length: 40 }, (_, i) => ({ key: 'skill:captain:s' + i, title: 's', text: 'word '.repeat(10000) })), { home: HOME });
  assert.ok(big.items.every((i) => i.text.length <= share.LIMITS.libraryText));
  assert.ok(Buffer.byteLength(JSON.stringify(big.items)) <= share.LIMITS.library);
  assert.ok(big.trimmed > 0);
});

test('library projection: skills go before notes, so a full library leaves out notes, not skills', () => {
  const notes = Array.from({ length: 20 }, (_, i) => ({ key: 'memory:n' + i + '.md', title: 'n', text: 'note '.repeat(3000) }));
  const skills = Array.from({ length: 5 }, (_, i) => ({ key: 'skill:captain:s' + i, title: 's', description: 'd', text: 'step '.repeat(3000) }));
  const out = share.projectLibrary([...notes, ...skills], { home: HOME, notes: true, maxBytes: 150 * 1024 });
  assert.deepEqual(out.items.slice(0, 5).map((i) => i.key), skills.map((s) => s.key));
  assert.ok(out.trimmed > 0 && out.items.length > 5, 'notes fill what is left');
});

test('libraryNeeds follows the skills and notes scopes; an old agentLibrary flag is ignored', () => {
  const g = (scopes, expiresAt = 2e12) => ({ scopes, expiresAt });
  assert.deepEqual(share.libraryNeeds([g(['board', 'agentLibrary'])], 1e12), { on: false, skills: false, notes: false });
  assert.deepEqual(share.libraryNeeds([g(['skills']), g(['board'])], 1e12), { on: true, skills: true, notes: false });
  assert.deepEqual(share.libraryNeeds([g(['notes'])], 1e12), { on: true, skills: false, notes: true });
  assert.deepEqual(share.libraryNeeds([g(['skills', 'notes'], 1)], 1e12), { on: false, skills: false, notes: false }, 'expired');
  assert.ok(!share.SCOPES.includes('agentLibrary'));
  assert.deepEqual(share.cleanGrant({ viewerEmail: 'g@keychain.com', scopes: ['board', 'agentLibrary'] }).scopes, ['board']);
});

test('agent: pushes the library only for skills or notes grants, on change or hourly, and removes it when no grant needs it', async (t) => {
  const clock = { t: 1e12 };
  const grants = [{ viewerEmail: 'grace@keychain.com', scopes: ['board', 'skills'], projects: ['*'], expiresAt: 2e12 }];
  const relay = fakeRelay({ grants });
  const dir = tempDir(t);
  const fleet = await richFleet();
  const asked = [];
  let lib = LIBRARY;
  const agent = share.createShareAgent({
    relayUrl: 'https://relay.example', dir, home: HOME, fetchImpl: relay.fetchImpl, now: () => clock.t,
    readFleet: async () => fleet, readTerminal: async () => 'pane', readExtras: async () => ({}),
    readLibrary: async (need) => { asked.push(need); return lib; },
  });
  await agent.signIn({ email: 'ada@keychain.com', password: 'pw' });
  const libCalls = () => relay.calls.filter((c) => c.path === '/v1/library');
  await agent.tick();
  assert.equal(libCalls().length, 1);
  assert.deepEqual(asked[0], { skills: true, notes: false });
  assert.deepEqual(libCalls()[0].body.items.map((i) => i.key), ['skill:captain:deploy']);
  assert.ok(!JSON.stringify(libCalls()[0].body).includes(HOME));
  clock.t += 61e3;
  await agent.tick();
  assert.equal(libCalls().length, 1, 'unchanged: not sent again');
  lib = [...LIBRARY, { key: 'skill:captain:new', title: 'New', text: 'x' }];
  clock.t += 61e3;
  await agent.tick();
  assert.equal(libCalls().length, 2, 'changed: sent');
  clock.t += 61 * 60e3;
  await agent.tick();
  assert.equal(libCalls().length, 3, 'hourly keep-alive');
  grants[0].scopes = ['board'];
  await agent.putGrant({ email: 'grace@keychain.com', scopes: ['board'], projects: ['*'] });
  await agent.tick();
  assert.equal(libCalls().at(-1).method, 'DELETE', 'no grant needs it: removed from the relay');
  const n = libCalls().length;
  clock.t += 61e3;
  await agent.tick();
  assert.equal(libCalls().length, n);
  // Pausing takes it down too.
  grants[0].scopes = ['notes'];
  await agent.putGrant({ email: 'grace@keychain.com', scopes: ['notes'], projects: ['*'] });
  await agent.tick();
  assert.deepEqual(asked.at(-1), { skills: false, notes: true });
  assert.deepEqual(libCalls().at(-1).body.items.map((i) => i.key), ['memory:fleet-habits.md'], 'notes only');
  assert.equal(libCalls().at(-1).method, 'POST');
  agent.setPaused(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(libCalls().at(-1).method, 'DELETE');
});
