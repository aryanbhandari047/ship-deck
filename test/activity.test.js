'use strict';
// First mate activity feed: tool summaries, redaction, incremental tailing with a
// partial last line, tool_result errors and durations, rotation to a newer
// session, the 200-event cap, the read-only guarantee and GET /api/activity.
// Fabricated transcript only (test/fixtures/transcript/firstmate.jsonl).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const activity = require('../lib/activity');
const { createServer } = require('../server');

const FIXTURE = path.join(__dirname, 'fixtures', 'transcript', 'firstmate.jsonl');
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T0 = Date.parse('2026-10-13T09:00:00Z');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Copies the fixture into <claudeDir>/projects/<encoded home>/<uuid>.jsonl.
function install(claudeDir, home, sessionId, { body, mtime } = {}) {
  const dir = path.join(claudeDir, 'projects', home.replace(/[/.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  const text = (body || fs.readFileSync(FIXTURE, 'utf8')).replaceAll('__HOME__', home).replaceAll('__SESSION__', sessionId);
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
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
const line = (o) => JSON.stringify(o) + '\n';

test('describeTool: friendly labels per tool', () => {
  const d = activity.describeTool;
  assert.deepEqual(d('Bash', { command: 'ls -la', description: 'List files' }), { icon: 'shell', label: 'List files', detail: 'ls -la' });
  assert.equal(d('Bash', { command: 'ls' }).label, 'Running a shell command');
  assert.equal(d('mcp__claude-in-chrome__navigate', { url: 'https://a.test/x' }).label, 'Browser: navigate https://a.test/x');
  assert.equal(d('mcp__claude-in-chrome__find', { query: 'login form' }).label, 'Browser: find "login form"');
  assert.equal(d('mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 2] }).label, 'Browser: left click');
  assert.equal(d('mcp__claude-in-chrome__computer', { action: 'screenshot' }).label, 'Browser: screenshot');
  assert.equal(d('mcp__claude-in-chrome__computer', { action: 'key', text: 'Return' }).label, 'Browser: key');
  assert.equal(d('mcp__claude-in-chrome__read_page', {}).label, 'Browser: read page');
  assert.equal(d('Read', { file_path: '/a/b/notes.md' }).label, 'Reading notes.md');
  assert.equal(d('Edit', { file_path: '/a/b/app.js' }).label, 'Editing app.js');
  assert.equal(d('Write', { file_path: '/a/b/out.txt' }).label, 'Writing out.txt');
  assert.equal(d('Agent', { description: 'Scout the bug' }).label, 'Delegated: Scout the bug');
  assert.equal(d('Task', { description: 'Old name' }).label, 'Delegated: Old name');
  assert.equal(d('Artifact', { file_path: '/x/report.html' }).label, 'Publishing report.html');
  assert.equal(d('Artifact', { file_path: '/x/report.html', title: 'Fleet' }).label, 'Publishing Fleet');
  assert.deepEqual(d('Grep', { pattern: 'x' }), { icon: 'tool', label: 'Grep' });
});

test('redaction: secret fields, typed text and inline credentials never reach a summary', () => {
  assert.deepEqual(Object.keys(activity.safeInput({ password: 1, api_token: 2, client_secret: 3, apiKey: 4, cookie: 5, Authorization: 6, url: 7 })), ['url']);
  const typed = activity.describeTool('mcp__claude-in-chrome__computer', { action: 'type', text: 'my secret words' });
  assert.equal(typed.label, 'Browser: typing…');
  assert.ok(!JSON.stringify(typed).includes('secret words'));
  const bash = activity.describeTool('Bash', { description: 'Call API', command: 'curl -H "Authorization: Bearer abc.def" -u x --password hunter2 GH_TOKEN=ghp_abcdefghijklmn https://a.test', token: 'zzz' });
  for (const leak of ['abc.def', 'hunter2', 'ghp_abcdefghijklmn', 'zzz']) assert.ok(!JSON.stringify(bash).includes(leak), leak);
  assert.match(bash.detail, /curl -H "Authorization: Bearer •••"/);
});

test('tails the first mate transcript: tool events, results, text, partial last line', (t) => {
  const home = tempDir(t, 'ship-deck-act-home-');
  const claudeDir = tempDir(t, 'ship-deck-act-claude-');
  const file = install(claudeDir, home, UUID(1));
  // A tool_result for tu_8 that is still being written (no trailing newline).
  const partial = line({ type: 'user', cwd: home, sessionId: UUID(1), timestamp: '2026-10-13T09:00:26.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_8', content: 'ok' }] } });
  fs.appendFileSync(file, partial.slice(0, 40));
  let now = T0 + 30000;
  const a = activity.createActivity({ home, claudeDir, now: () => now });

  const v = a.view(NaN, null);
  assert.equal(v.full, true);
  assert.equal(v.sessionId, UUID(1));
  const tools = v.events.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => e.label), [
    'Read the blocked worker status', 'Reading backlog.md', 'Browser: navigate https://example.test/pulls', 'Browser: typing…',
    'Browser: find "merge button"', 'Delegated: Survey open PRs', 'SomeCustomTool', 'Editing captain.md', 'Publishing Fleet report',
  ]);
  const by = Object.fromEntries(tools.map((e) => [e.label, e]));
  assert.equal(by['Read the blocked worker status'].status, 'done');
  assert.equal(by['Read the blocked worker status'].detail, 'tail -n 5 state/delta-block.status');
  assert.equal(by['Read the blocked worker status'].duration, 1000);
  assert.equal(by['Browser: navigate https://example.test/pulls'].status, 'failed', 'is_error marks the tool failed');
  assert.equal(by['Browser: navigate https://example.test/pulls'].duration, 2000);
  assert.equal(by['Delegated: Survey open PRs'].duration, 6000);
  assert.equal(by['Editing captain.md'].status, 'running', 'its result line is not complete yet');
  assert.ok(!tools.some((e) => e.tool === 'Grep'), 'sidechain lines are skipped');
  const text = v.events.find((e) => e.kind === 'text');
  assert.ok(text.label.startsWith('Checking the fleet now'));
  assert.ok(text.label.length <= 140 && text.label.endsWith('…'));
  const all = JSON.stringify(v);
  for (const leak of ['hunter2-not-a-real-password', 'tok_FAKE_000', 'Bearer x', 'toolId']) assert.ok(!all.includes(leak), leak);
  assert.equal(v.working, true);
  assert.equal(v.running, true);

  // Incremental: nothing new, then the partial line completes.
  const v2 = a.view(v.rev, v.epoch);
  assert.equal(v2.full, false);
  assert.deepEqual(v2.events, []);
  fs.appendFileSync(file, partial.slice(40));
  const before = fingerprint(claudeDir); // the test itself wrote until here
  const v3 = a.view(v2.rev, v2.epoch);
  assert.deepEqual(v3.events.map((e) => [e.label, e.status, e.duration]), [['Editing captain.md', 'done', 3000]]);
  assert.equal(a.view(v3.rev, 'other-epoch').full, true, 'an unknown epoch gets the whole feed');

  // Idle: no running tool except the Artifact one, which goes stale after 10 min.
  now = T0 + 11 * 60000;
  assert.equal(a.state().working, false);
  a.view(NaN, null);
  assert.deepEqual(fingerprint(claudeDir), before, 'the transcript dir is never written');
});

test('rotation to a newer first mate session and the 200-event cap', (t) => {
  const home = tempDir(t, 'ship-deck-act-home-');
  const claudeDir = tempDir(t, 'ship-deck-act-claude-');
  install(claudeDir, home, UUID(1), { mtime: T0 + 60000 });
  let now = T0 + 120000;
  const a = activity.createActivity({ home, claudeDir, now: () => now });
  const v = a.view(NaN, null);
  assert.equal(v.events.find((e) => e.label === 'Publishing Fleet report').status, 'running');

  const head = { type: 'user', cwd: home, sessionId: UUID(2), timestamp: '2026-10-13T10:00:00.000Z', message: { content: 'go' } };
  let body = line(head);
  for (let i = 0; i < 195; i++) {
    body += line({ type: 'assistant', cwd: home, sessionId: UUID(2), timestamp: '2026-10-13T10:00:01.000Z', message: { content: [{ type: 'tool_use', id: 'n' + i, name: 'Read', input: { file_path: `/f/${i}.md` } }] } });
  }
  install(claudeDir, home, UUID(2), { body, mtime: T0 + 180000 });
  assert.equal(a.view(v.rev, v.epoch).sessionId, UUID(1), 'discovery is cached for a few seconds');
  now += 6000;
  const r = a.view(v.rev, v.epoch);
  assert.equal(r.sessionId, UUID(2));
  const full = a.view(NaN, null);
  assert.equal(full.events.length, activity.MAX_EVENTS);
  assert.equal(full.events.at(-1).label, 'Reading 194.md');
  assert.ok(!full.events.some((e) => e.kind === 'text'), 'oldest events fall off');
  assert.equal(full.events.find((e) => e.label === 'Publishing Fleet report').status, 'unknown', 'running tools of the old session end as unknown');
  assert.ok(r.events.some((e) => e.kind === 'session' && e.label.includes('00000000')), 'a session marker is emitted');
  assert.equal(r.running, true);
});

test('a long transcript is read from its tail only, skipping the cut line', (t) => {
  const home = tempDir(t, 'ship-deck-act-home-');
  const claudeDir = tempDir(t, 'ship-deck-act-claude-');
  const head = line({ type: 'user', cwd: home, sessionId: UUID(3), timestamp: '2026-10-13T09:00:00.000Z', message: { content: 'go' } });
  const filler = line({ type: 'user', timestamp: '2026-10-13T09:00:01.000Z', message: { content: 'x'.repeat(2000) } });
  const tail = line({ type: 'assistant', timestamp: '2026-10-13T09:00:02.000Z', message: { content: [{ type: 'text', text: 'Last word' }] } });
  install(claudeDir, home, UUID(3), { body: head + filler.repeat(700) + tail });
  const a = activity.createActivity({ home, claudeDir, now: () => T0 + 5000 });
  assert.deepEqual(a.view(NaN, null).events.map((e) => e.label), ['Last word']);
});

test('GET /api/activity serves the feed from --claude-dir', async (t) => {
  const home = tempDir(t, 'ship-deck-act-home-');
  fs.mkdirSync(path.join(home, 'state'));
  const claudeDir = tempDir(t, 'ship-deck-act-claude-');
  const ordersDir = tempDir(t, 'ship-deck-act-orders-');
  install(claudeDir, home, UUID(4));
  const server = createServer({ home, tmux: false, ordersDir, memoryDir: null, claudeDir, exec: async () => { throw new Error('no exec in tests'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const get = (q) => fetch(`http://127.0.0.1:${port}/api/activity${q}`).then((r) => r.json());
  const first = await get('');
  assert.equal(first.sessionId, UUID(4));
  assert.ok(first.events.length >= 10);
  const next = await get(`?since=${first.rev}&epoch=${first.epoch}`);
  assert.equal(next.full, false);
  assert.deepEqual(next.events, []);
});
