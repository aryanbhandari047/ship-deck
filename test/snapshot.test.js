'use strict';
// End-to-end checks against a temp copy of the fixture home: snapshot shape,
// missing files, read-only guarantee, and the live HTTP server picking up a
// status change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSnapshot, reportPath } = require('../lib/fleet');
const { createServer, parseArgs } = require('../server');

const FIX = path.join(__dirname, 'fixtures', 'home');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-test-'));
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}

// Every file under dir with its size and mtime: proves nothing was written.
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

const noTmux = { listTmux: async () => new Set(['fleet:fm-alpha-fix', 'fleet:zsh']) };

test('snapshot of the fixture home', async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now();
  fs.utimesSync(path.join(home, 'state', '.last-watcher-beat'), new Date(now - 30000), new Date(now - 30000));

  const s = await buildSnapshot(home, { ...noTmux, now });
  const byId = Object.fromEntries(s.tasks.map((x) => [x.id, x]));

  assert.deepEqual(Object.keys(byId).sort(),
    ['alpha-fix', 'beta-scout', 'delta-block', 'epsilon-resume', 'gamma-decision', 'north-mate', 'zeta-new']);
  assert.equal(s.afk, true);
  assert.equal(s.watcher.healthy, true);
  assert.ok(s.watcher.ageSec >= 29 && s.watcher.ageSec <= 31);
  assert.deepEqual(s.tmux, { available: true, windows: 2 });

  const a = byId['alpha-fix'];
  assert.equal(a.state, 'working');
  assert.equal(a.project, 'harbor-app');
  assert.equal(a.pr, 'https://github.com/example-org/harbor-app/pull/42');
  assert.equal(a.alive, true);
  assert.ok(a.turnEnded > 0);
  assert.equal(a.lastStatus.length, 3);
  assert.ok(a.lastStatus[2].approxTs > 0, 'untimestamped last line gets file mtime');
  assert.equal(a.brief, null);

  const b = byId['beta-scout'];
  assert.equal(b.state, 'done');
  assert.equal(b.kind, 'scout');
  assert.equal(b.project, 'harbor-app', 'case and trailing slash fold into the registry name');
  assert.equal(b.hasReport, true);
  assert.match(b.brief, /^Diagnose why the tide chart drifts/);
  assert.equal(b.alive, false);

  assert.equal(byId['gamma-decision'].state, 'needs-decision');
  assert.equal(byId['delta-block'].state, 'blocked');
  assert.equal(byId['epsilon-resume'].state, 'working');
  assert.equal(byId['epsilon-resume'].rawState, 'resolved');
  const z = byId['zeta-new'];
  assert.equal(z.state, 'unknown', 'missing .status file');
  assert.deepEqual(z.lastStatus, []);
  assert.equal(z.turnEnded, null);
  assert.equal(z.hasReport, false);
  assert.equal(byId['north-mate'].kind, 'secondmate');

  assert.deepEqual(s.counts, { working: 3, done: 1, 'needs-decision': 1, blocked: 1, unknown: 1 });
  assert.equal(s.backlog.queued.length, 4);
  assert.equal(s.backlog.captain.length, 1);
  assert.equal(s.secondmates.registry.length, 2);
  assert.equal(s.projects.length, 2);
});

test('snapshot never writes to the home', async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const before = fingerprint(home);
  const dirsBefore = fs.readdirSync(path.join(home, 'state')).sort();
  for (let i = 0; i < 3; i++) await buildSnapshot(home, noTmux);
  assert.deepEqual(fingerprint(home), before);
  assert.deepEqual(fs.readdirSync(path.join(home, 'state')).sort(), dirsBefore);
});

test('missing files and an empty home are tolerated', async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-deck-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const s = await buildSnapshot(empty, { tmux: false });
  assert.deepEqual(s.tasks, []);
  assert.equal(s.afk, false);
  assert.equal(s.watcher.lastBeat, null);
  assert.equal(s.watcher.healthy, false);
  assert.equal(s.backlog.present, false);
  assert.equal(s.secondmates.registryPresent, false);
  assert.deepEqual(s.tmux, { available: false });

  // A home with state/ but no data/ and no beat.
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.rmSync(path.join(home, 'data'), { recursive: true });
  fs.rmSync(path.join(home, 'state', '.last-watcher-beat'));
  const s2 = await buildSnapshot(home, { tmux: false });
  assert.equal(s2.tasks.length, 7);
  assert.equal(s2.tasks.find((x) => x.id === 'beta-scout').brief, null);
  assert.equal(s2.tasks.find((x) => x.id === 'alpha-fix').alive, null, 'unknown liveness without tmux');
  assert.equal(s2.watcher.healthy, false);
});

test('stale heartbeat is not healthy', async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now();
  fs.utimesSync(path.join(home, 'state', '.last-watcher-beat'), new Date(now - 300000), new Date(now - 300000));
  const s = await buildSnapshot(home, { tmux: false, now });
  assert.equal(s.watcher.healthy, false);
  assert.ok(s.watcher.ageSec >= 299);
});

// Ages every state/<id>.* file so the task's last activity is `days` old.
function age(home, id, days, now) {
  const when = new Date(now - days * 86400000);
  for (const ext of ['meta', 'status', 'turn-ended']) {
    const p = path.join(home, 'state', `${id}.${ext}`);
    if (fs.existsSync(p)) fs.utimesSync(p, when, when);
  }
}

test('stale crew: flagged, bucketed out of their state count, threshold configurable', async (t) => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now();
  age(home, 'gamma-decision', 10, now); // needs-decision, 10 d quiet
  age(home, 'delta-block', 8, now); // blocked, 8 d quiet
  age(home, 'alpha-fix', 3, now); // working, 3 d: fresh under the default
  age(home, 'beta-scout', 40, now); // done: never stale

  const s = await buildSnapshot(home, { tmux: false, now });
  assert.equal(s.staleDays, 7);
  const byId = Object.fromEntries(s.tasks.map((x) => [x.id, x]));
  assert.equal(byId['gamma-decision'].stale, true);
  assert.equal(byId['gamma-decision'].state, 'needs-decision', 'underlying state is kept');
  assert.equal(byId['delta-block'].stale, true);
  assert.equal(byId['alpha-fix'].stale, false);
  assert.equal(byId['beta-scout'].stale, false);
  assert.deepEqual(s.counts, { stale: 2, working: 3, done: 1, unknown: 1 });
  assert.equal(s.counts['needs-decision'], undefined);
  assert.equal(s.counts.blocked, undefined);
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, s.tasks.length, 'counts still sum to the crew size');

  const loose = await buildSnapshot(home, { tmux: false, now, staleDays: 9 });
  assert.equal(loose.staleDays, 9);
  assert.deepEqual(loose.tasks.filter((x) => x.stale).map((x) => x.id), ['gamma-decision']);
  assert.equal(loose.counts.blocked, 1);

  const strict = await buildSnapshot(home, { tmux: false, now, staleDays: 2 });
  assert.deepEqual(strict.tasks.filter((x) => x.stale).map((x) => x.id).sort(), ['alpha-fix', 'delta-block', 'gamma-decision']);
});

test('parseArgs reads --stale-days and SHIP_DECK_STALE_DAYS', (t) => {
  const prev = process.env.SHIP_DECK_STALE_DAYS;
  t.after(() => { if (prev === undefined) delete process.env.SHIP_DECK_STALE_DAYS; else process.env.SHIP_DECK_STALE_DAYS = prev; });
  delete process.env.SHIP_DECK_STALE_DAYS;
  assert.equal(parseArgs([]).staleDays, 7);
  assert.equal(parseArgs(['--stale-days', '14']).staleDays, 14);
  assert.equal(parseArgs(['--stale-days=2.5']).staleDays, 2.5);
  process.env.SHIP_DECK_STALE_DAYS = '3';
  assert.equal(parseArgs([]).staleDays, 3);
  assert.equal(parseArgs(['--stale-days', '5']).staleDays, 5, 'flag beats env');
});

test('reportPath rejects traversal', () => {
  assert.ok(reportPath(FIX, 'beta-scout'));
  assert.equal(reportPath(FIX, 'alpha-fix'), null);
  assert.equal(reportPath(FIX, '../state'), null);
  assert.equal(reportPath(FIX, '..'), null);
  assert.equal(reportPath(FIX, ''), null);
});

test('server serves the fleet and reflects a status change', async (t) => {
  const home = tempHome();
  const server = createServer({ home, tmux: false, staleDays: 7 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const fleet = async () => (await fetch(base + '/api/fleet')).json();
  let s = await fleet();
  assert.equal(s.tasks.find((x) => x.id === 'delta-block').state, 'blocked');

  assert.equal(s.staleDays, 7, 'server passes its stale threshold to the snapshot');

  fs.appendFileSync(path.join(home, 'state', 'delta-block.status'), 'working: database is back, resuming\n');
  s = await fleet();
  const d = s.tasks.find((x) => x.id === 'delta-block');
  assert.equal(d.state, 'working');
  assert.equal(d.lastStatus.at(-1).note, 'database is back, resuming');

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ship Deck/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/api/report/beta-scout')).status, 200);
  assert.equal((await fetch(base + '/api/report/..%2Fstate')).status, 404);
  assert.equal((await fetch(base + '/..%2Fserver.js')).status, 403);
  assert.equal((await fetch(base + '/api/fleet', { method: 'POST' })).status, 405);
});
