'use strict';
// Test relay: the dev server on a memory store with a movable clock, plus a small cookie-aware client.
const { createDevServer } = require('../dev');
const { loadConfig } = require('../lib/config');
const { createPasswordAuth } = require('../auth/password');

async function startRelay(t, { env = {} } = {}) {
  const clock = { t: Date.parse('2026-10-14T12:00:00Z') };
  const logs = [];
  const config = loadConfig({ SESSION_SECRET: 'test-secret-'.repeat(4), PUBLIC_BASE_URL: 'http://127.0.0.1:1', ...env });
  const { server, store } = createDevServer({ config, now: () => clock.t, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const base = config.baseUrl;
  const auth = createPasswordAuth({ store, config, now: () => clock.t });

  // One browser: keeps its cookie; sends same-origin JSON like the relay's own pages.
  function browser() {
    let cookie = null;
    async function call(method, p, body, headers = {}) {
      const r = await fetch(base + p, {
        method,
        redirect: 'manual',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: base, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data, headers: r.headers, raw: text, setCookie: set };
    }
    return { call, get cookie() { return cookie; }, set cookie(c) { cookie = c; } };
  }
  // A deck: bearer token only, no cookies, no Origin.
  async function deckCall(token, method, p, body) {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers, raw: text };
  }
  // A person with an account: invite + accept, returns their signed-in browser.
  async function person(email, password = 'a long password ' + email) {
    const inv = await auth.createInvite({ email });
    const b = browser();
    const r = await b.call('POST', '/api/auth/accept', { token: inv.link.split('#')[1], password });
    if (r.status !== 200) throw new Error('accept failed: ' + JSON.stringify(r.data));
    return Object.assign(b, { email, password });
  }
  async function captain(email = 'ada@keychain.com') {
    const p = await person(email);
    const r = await deckCall(null, 'POST', '/v1/device/login', { email, password: p.password, device: 'Test deck' });
    if (r.status !== 200) throw new Error('device login failed: ' + JSON.stringify(r.data));
    return Object.assign(p, { token: r.data.token, sub: r.data.account.sub });
  }
  return { base, config, store, clock, logs, auth, browser, deckCall, person, captain };
}

// A minimal valid push.
function snapshot(workers = [{ ref: 'refAAAAAAAAA', id: 'alpha-fix', title: 'Fix the crash', project: 'harbor-app', state: 'working' }, { ref: 'refBBBBBBBBB', id: 'beta', title: 'Private thing', project: 'lighthouse-api', state: 'needs-decision', options: [{ letter: 'A', text: 'one' }] }]) {
  return {
    v: 1, at: 1, scopes: ['board', 'updates', 'terminal'], projects: ['*'], hiddenProjects: 0,
    fleet: { counts: {}, firstMate: { state: 'idle', since: 1 }, monitoring: 'ok' },
    workers: workers.map((w) => ({ quietDays: null, summary: '', updatedAt: 1, options: [], pr: null, model: 'opus', effort: 'high', ...w })),
    updates: Object.fromEntries(workers.map((w) => [w.ref, [{ ts: '2026-10-14 10:00', state: 'working', note: 'update for ' + w.id }]])),
    terminal: Object.fromEntries(workers.map((w) => [w.ref, { at: 1, lines: ['$ npm test', 'ok ' + w.id] }])),
  };
}

module.exports = { startRelay, snapshot };
