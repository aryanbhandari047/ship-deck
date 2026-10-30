'use strict';
// Ask a teammate's context: with the `ask` scope a teammate's agent asks a question and gets up to
// 3 short cited passages from what the captain granted, ranked on the relay; nothing is synced
// into their skills, the question is redacted before it leaves and logged for the captain, and
// limits, notes tags, private notes and revocation all hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../relay/lib/ask');
const RL = require('../relay/lib/library');
const { parseFrontmatter } = require('../lib/library');
const { createServer, listen } = require('../server');
const { startRelay } = require('../relay/test/helpers');

const FIX = path.join(__dirname, 'fixtures', 'home');
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-ask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ranking: term summaries pick items, BM25 picks passages of whole lines', () => {
  const items = [
    { key: 'skill:captain:deploy', title: 'deploy', description: 'How we ship the harbor app', text: '# Deploy\n\nRun the release script.\nThen tag the harbor build.' },
    { key: 'skill:captain:review', title: 'review', description: 'Code review', text: 'Read the diff twice.' },
  ];
  const sum = A.summarize(items);
  assert.ok(sum['skill:captain:deploy'].t.harbor >= 4, 'title and description weigh more');
  const ranked = A.bm25('how do we deploy harbor?', Object.entries(sum).map(([id, s]) => ({ id, n: s.n, tf: s.t })));
  assert.deepEqual(ranked.map((r) => r.id), ['skill:captain:deploy']);
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} about harbor deploys and other things`).join('\n');
  const ps = A.passages(long);
  assert.ok(ps.every((p) => p.text.length <= A.PASSAGE_CHARS && p.text.split('\n').length === p.to - p.from + 1));
  assert.equal(ps[0].from, 1);
  assert.throws(() => A.sanitizeQuestion({ question: '?? !!' }));
  assert.equal(A.sanitizeQuestion({ question: 'x'.repeat(900) + ' deploy' }).question.length, A.MAX_QUESTION);
  const g = { scopes: ['ask'], notesTagged: true };
  assert.equal(RL.askAllowed({ key: 'skill:captain:x' }, g), true);
  assert.equal(RL.askAllowed({ key: 'memory:a.md', tag: null }, g), false);
  assert.equal(RL.askAllowed({ key: 'memory:a.md', tag: 'share' }, g), true);
  assert.equal(RL.askAllowed({ key: 'skill:captain:x' }, { scopes: ['skills'] }), false);
});

async function startDeck(t, relay, name) {
  const dir = tempDir(t);
  fs.cpSync(FIX, path.join(dir, 'home'), { recursive: true });
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const server = createServer({
    home: path.join(dir, 'home'), ordersDir: path.join(dir, 'orders'), claudeDir, memoryDir: null, tmux: false, wake: false, captainName: name,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }), share: true, shareRelay: relay.base, shareNow: () => relay.clock.t,
  });
  const port = await listen(server, 0);
  t.after(() => server.close());
  const call = async (method, p, body, headers = { 'X-Ship-Deck': '1' }) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const token = () => JSON.parse(fs.readFileSync(path.join(dir, 'orders', 'share.json'), 'utf8')).token;
  return { call, dir, port, token, skills: path.join(claudeDir, 'skills'), agent: server.shareAgent };
}

test('end to end: ask returns cited passages without syncing; redaction, tags, limits, audit, revoke', async (t) => {
  const relay = await startRelay(t);
  const people = await Promise.all(['ada', 'grace', 'sam'].map((n) => relay.person(n + '@keychain.com')));
  const [ada, grace, sam] = await Promise.all(['Ada', 'Grace', 'Sam'].map((n) => startDeck(t, relay, n)));
  fs.mkdirSync(path.join(ada.skills, 'deploy'), { recursive: true });
  const deploy = ['---', 'name: deploy', 'description: How we ship the harbor app', '---', '# Deploy', '', 'Run the release script from the harbor repo.', 'Then tag the harbor build and post in the channel.',
    ...Array.from({ length: 30 }, (_, i) => `Unrelated padding line ${i} about lunch menus and parking.`)].join('\n');
  fs.writeFileSync(path.join(ada.skills, 'deploy', 'SKILL.md'), deploy);
  const data = path.join(ada.dir, 'home', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'captain.md'), 'Harbor releases happen on Tuesdays (marked Share).\n');
  fs.writeFileSync(path.join(data, 'captain-shared.md'), 'Harbor rollback secrets live in the vault (untagged).\n');
  fs.writeFileSync(path.join(data, 'learnings.md'), 'Harbor private learning (private).\n');
  for (const [deck, p] of [[ada, people[0]], [grace, people[1]], [sam, people[2]]]) await deck.call('POST', '/api/share/signin', { email: p.email, password: p.password });
  await ada.call('POST', '/api/share/item', { key: 'home:data/captain.md', tag: 'share' });
  await ada.call('POST', '/api/share/item', { key: 'home:data/learnings.md', tag: 'private' });
  assert.equal((await ada.call('POST', '/api/share/grant', { email: 'grace@keychain.com', scopes: ['ask'], projects: ['*'], notesTagged: true })).status, 200);
  await ada.agent.tick(); // pushes the library: an ask grant needs it

  // Grace's deck syncs no skills or notes, only the teammate-ask skill that says how to ask.
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.deepEqual(fs.readdirSync(grace.skills), ['teammate-ask']);
  const skill = fs.readFileSync(path.join(grace.skills, 'teammate-ask', 'SKILL.md'), 'utf8');
  assert.equal(parseFrontmatter(skill).name, 'teammate-ask');
  assert.ok(skill.includes(`http://127.0.0.1:${grace.port}/api/share/ask`), skill);
  assert.ok(skill.includes('Ada'), skill);
  assert.match(skill, /shown to the teammate in their log/);
  assert.deepEqual((await grace.call('GET', '/api/share')).data.knowledge.ask.map((a) => a.name), ['Ada']);

  // A question: at most 3 passages of at most 600 characters, cited, from allowed items only.
  let n = relay.store.stats.commands;
  let r = await grace.call('POST', '/api/share/ask', { question: 'How do we release harbor? my token ghp_abcdefghijklmnopqrstuvwxyz0123456789', captain: 'ada' });
  const cost = relay.store.stats.commands - n;
  assert.equal(r.status, 200);
  const ps = r.data.passages;
  assert.ok(ps.length >= 1 && ps.length <= 3);
  for (const p of ps) {
    assert.ok(p.text.length <= 600);
    assert.equal(p.captain, 'Ada');
    assert.equal(p.lines.length, 2);
    assert.ok(!/untagged|private/.test(p.text), 'never an untagged note for a marked-only grant, never a private one');
  }
  assert.ok(ps.some((p) => p.title === 'deploy' && p.text.includes('release script')));
  assert.ok(ps.some((p) => p.text.includes('Tuesdays')), 'a note marked Share');
  assert.ok(!ps.some((p) => p.text.includes('padding line 29')), 'only the matching lines, not the whole skill');
  assert.equal(cost, 18, 'free-tier budget: auth 1, viewer list 2, limits 4, ranking 2, 3 items 3, audit 2, quoted counts 3 + expiry 1');
  // Ada's log has the question, redacted on Grace's deck before it left.
  const row = (await ada.call('GET', '/api/share/audit')).data.rows.find((x) => x.result === 'asked');
  assert.equal(row.who, 'grace@keychain.com');
  assert.match(row.what, /^Asked "How do we release harbor\? my token \[token hidden\]": quoted "deploy"/);
  const [, all] = await relay.store.cmd(['SCAN', '0', 'MATCH', '*']);
  const dump = async (k) => {
    for (const c of [['GET', k], ['HGETALL', k], ['SMEMBERS', k], ['ZREVRANGEBYSCORE', k, '+inf', '-inf']]) {
      try { return JSON.stringify(await relay.store.cmd(c)); } catch { /* another type */ }
    }
    return '';
  };
  for (const k of all) assert.ok(!(await dump(k)).includes('ghp_'), k);
  // Quoted counts reach Ada's usage table.
  const usage = (await ada.call('GET', '/api/share/usage')).data.rows;
  assert.ok(usage.find((u) => u.title === 'deploy').cited >= 1);

  // Refusals: no grant, unknown name, no header, a browser origin.
  assert.equal((await sam.call('POST', '/api/share/ask', { question: 'how do we release harbor' })).status, 403);
  assert.equal((await grace.call('POST', '/api/share/ask', { question: 'how do we release harbor', captain: 'bob' })).status, 403);
  assert.equal((await grace.call('POST', '/api/share/ask', { question: 'how do we release harbor' }, {})).status, 403);
  assert.equal((await grace.call('POST', '/api/share/ask', { question: 'how do we release harbor' }, { 'X-Ship-Deck': '1', Origin: 'https://evil.example' })).status, 403);

  // 30 an hour per grant: the 31st is refused, audited once.
  const tok = grace.token();
  for (let i = 1; i < A.PER_HOUR; i++) assert.equal((await relay.deckCall(tok, 'POST', '/v1/ask', { question: 'harbor release ' + i })).status, 200);
  assert.equal((await relay.deckCall(tok, 'POST', '/v1/ask', { question: 'harbor release again' })).status, 429);
  assert.equal((await relay.deckCall(tok, 'POST', '/v1/ask', { question: 'harbor release again' })).status, 429);
  const refused = (await ada.call('GET', '/api/share/audit')).data.rows.filter((x) => x.what === 'Questions from their agent' && x.result === 'refused');
  assert.equal(refused.length, 1);
  relay.clock.t += 3600e3;
  assert.equal((await relay.deckCall(tok, 'POST', '/v1/ask', { question: 'harbor release next hour' })).status, 200);

  // Revoked: refused at once, and the teammate-ask skill goes on the next sync.
  await ada.call('POST', '/api/share/revoke', { viewer: 'grace@keychain.com' });
  assert.equal((await grace.call('POST', '/api/share/ask', { question: 'how do we release harbor' })).status, 403);
  relay.clock.t += 10 * 60e3;
  assert.equal(await grace.agent.syncKnowledge(), 'synced');
  assert.deepEqual(fs.readdirSync(grace.skills), []);
});
