'use strict';
// Read-only teammate sharing, deck side (opt-in with --share). An allow-listed, redacted projection
// of /api/fleet is pushed outbound over HTTPS to the Keychain relay (relay/); nothing listens for
// the relay. Everything read back from the relay is data: this module never requires orders, wake
// or actions, so no relay response can become an order or an fm-send (test/share.test.js checks).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const board = require('../public/board');
const { redact, stripAnsi, cap, DEFAULT_HOSTS } = require('./redact');

const SCOPES = ['board', 'updates', 'model', 'skills', 'terminal', 'notes', 'chat'];
const DEFAULT_SCOPES = ['board', 'updates', 'model'];
const GRANT_DAYS = [1, 7, 30];
const STATE_FILE = 'share.json';
const LIMITS = {
  title: 120, summary: 200, option: 200, note: 200, terminalLines: 40, terminalLine: 240,
  noteText: 8000, chatText: 500, chatItems: 30, activityItems: 30, skills: 100, snapshot: 64 * 1024,
};
// Exactly what may leave the laptop (Appendix D). The relay re-applies the same lists.
const WORKER_KEYS = ['ref', 'id', 'title', 'project', 'state', 'quietDays', 'summary', 'updatedAt', 'options', 'pr', 'model', 'effort'];
const SNAPSHOT_KEYS = ['v', 'at', 'scopes', 'projects', 'hiddenProjects', 'fleet', 'workers', 'updates', 'terminal', 'skills', 'notes', 'chat', 'activity', 'trimmed'];
// Dropped first when a snapshot is over 64 KB.
const TRIM_ORDER = ['terminal', 'notes', 'activity', 'chat', 'updates', 'skills'];
const TIMING = {
  tick: 10e3, minPush: 30e3, keepAlive: 10 * 60e3, terminal: 30e3, grants: 10 * 60e3,
  backoffBase: 30e3, backoffMax: 15 * 60e3, request: 10e3,
};
const STATES = new Set(Object.keys(board.STATE_TONE));
const SAFE_WORD = /^[\w.:-]{1,60}$/;

// ---------- projection ----------

// A stable worker reference the relay can key on without learning more than the id itself.
function workerRef(key, id) {
  return crypto.createHmac('sha256', key).update(String(id)).digest('base64url').slice(0, 16);
}

const lower = (s) => String(s || '').toLowerCase();
// projects: ['*'] for all, or display names; unassigned work is shared only under '*'.
function sharedProject(name, projects) {
  if ((projects || []).includes('*')) return true;
  if (!name || name === 'unassigned') return false;
  return projects.some((p) => lower(p) === lower(name));
}

// github.com pull request links only; anything else keeps just its number.
function prOf(pr) {
  if (!pr) return null;
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/.exec(String(pr));
  if (m) return { number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, ci: null };
  const n = /^#?(\d{1,7})$/.exec(String(pr).trim());
  return n ? { number: Number(n[1]), url: null, ci: null } : null;
}

// The share snapshot for the given scopes and projects (the union over active grants; the relay
// narrows it per viewer). fleet: the /api/fleet object. extras: { firstMate: { state, since },
// terminal: { id: text }, skills, notes, thread, activity } from the deck's own readers.
function projectSnapshot(fleet, opts = {}) {
  const now = opts.now || Date.now();
  const scopes = new Set((opts.scopes || []).filter((s) => SCOPES.includes(s)));
  const projects = (opts.projects || []).filter((p) => typeof p === 'string' && p).map((p) => cap(p, 100));
  const extras = opts.extras || {};
  const rx = { home: opts.home, hosts: opts.hosts || DEFAULT_HOSTS };
  const r = (s, max) => cap(redact(s, rx), max);
  const key = opts.key || 'ship-deck';

  const tasks = ((fleet && fleet.tasks) || []).filter((t) => t && t.kind !== 'secondmate');
  const shown = tasks.filter((t) => sharedProject(t.project, projects));
  const hidden = new Set(tasks.filter((t) => !sharedProject(t.project, projects)).map((t) => lower(t.project || 'unassigned')));
  const out = { v: 1, at: now, scopes: SCOPES.filter((s) => scopes.has(s)), projects: projects.includes('*') ? ['*'] : projects, hiddenProjects: hidden.size };

  const counts = { needs: 0, working: 0, waiting: 0, done: 0, quiet: 0 };
  for (const t of shown) counts[board.columnOf({ state: t.state, stale: t.stale })]++;
  out.fleet = {
    counts,
    firstMate: extras.firstMate ? { state: extras.firstMate.state === 'working' ? 'working' : 'idle', since: Number(extras.firstMate.since) || null } : null,
    monitoring: fleet && fleet.watcher && fleet.watcher.healthy ? 'ok' : 'late',
  };

  const refs = new Map(shown.map((t) => [t.id, workerRef(key, t.id)]));
  out.workers = shown.map((t) => {
    const c = t.config || {};
    const w = {
      ref: refs.get(t.id),
      id: r(t.id, 80),
      title: r(t.title || t.id, LIMITS.title),
      project: t.project && t.project !== 'unassigned' ? r(t.project, 100) : null,
      state: STATES.has(t.state) ? t.state : 'unknown',
      quietDays: t.stale ? board.quietDays(t.lastActivity, now) : null,
      summary: r(board.cardSummary(t, 400), LIMITS.summary),
      updatedAt: Math.round(Number(t.statusMtime)) || null,
      options: (t.options || []).slice(0, 8).map((o) => ({ letter: /^[A-Z]$/.test(o.letter) ? o.letter : '?', text: r(o.text, LIMITS.option) })),
      pr: prOf(t.pr),
    };
    if (scopes.has('model')) {
      const model = c.model || t.model;
      const effort = c.effort || t.effort;
      w.model = SAFE_WORD.test(model || '') ? model : null;
      w.effort = SAFE_WORD.test(effort || '') ? effort : null;
    }
    return w;
  });

  if (scopes.has('updates')) {
    out.updates = {};
    for (const t of shown) {
      out.updates[refs.get(t.id)] = (t.lastStatus || []).slice(-5).map((e) => ({
        ts: typeof e.ts === 'string' ? cap(e.ts, 25) : null,
        state: STATES.has(e.state) ? e.state : 'unknown',
        note: r(e.note, LIMITS.note),
      }));
    }
  }
  if (scopes.has('terminal') && extras.terminal) {
    out.terminal = {};
    for (const t of shown) {
      const pane = extras.terminal[t.id];
      if (!pane || typeof pane.text !== 'string') continue;
      // Redact the whole pane first so multi-line secrets (PEM blocks) are caught.
      const lines = redact(stripAnsi(pane.text), rx).split('\n').map((l) => l.trimEnd());
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      out.terminal[refs.get(t.id)] = { at: Number(pane.at) || now, lines: lines.slice(-LIMITS.terminalLines).map((l) => cap(l, LIMITS.terminalLine)) };
    }
  }
  if (scopes.has('skills')) {
    out.skills = (extras.skills || []).slice(0, LIMITS.skills).map((e) => ({ key: r(e.key, 120), title: r(e.title, 120), description: r(e.description, 300) }));
  }
  if (scopes.has('notes')) {
    out.notes = (extras.notes || []).map((n) => ({ key: r(n.key, 120), title: r(n.title, 120), text: r(n.text, LIMITS.noteText) }));
  }
  if (scopes.has('chat')) {
    out.chat = (extras.thread || []).slice(-LIMITS.chatItems).map((x) => ({
      ts: typeof x.ts === 'string' ? cap(x.ts, 30) : null,
      from: x.type === 'reply' ? 'firstmate' : 'captain',
      text: r(x.text || '', LIMITS.chatText),
    }));
    out.activity = (extras.activity || []).slice(-LIMITS.activityItems).map((e) => ({ ts: Number(e.ts) || null, label: r(e.label, 160) }));
  }
  return fitToCap(out, opts.maxBytes || LIMITS.snapshot);
}

const sizeOf = (o) => Buffer.byteLength(JSON.stringify(o));
// Drops optional sections, then trailing workers, until the snapshot fits; records what went.
function fitToCap(snap, max = LIMITS.snapshot) {
  if (sizeOf(snap) <= max) return snap;
  snap.trimmed = [];
  for (const k of TRIM_ORDER) {
    if (snap[k] === undefined) continue;
    delete snap[k];
    snap.trimmed.push(k);
    if (sizeOf(snap) <= max) return snap;
  }
  while (snap.workers.length && sizeOf(snap) > max) snap.workers.pop();
  snap.trimmed.push('workers');
  return snap;
}

// Change detector for pushes: everything but the build time and the first mate's busy/idle flag,
// which flips every few seconds; it rides along with the next real change or keep-alive.
function snapshotHash(snap) {
  const { at, fleet, ...rest } = snap;
  const { firstMate, ...health } = fleet || {};
  return crypto.createHash('sha256').update(JSON.stringify({ ...rest, health })).digest('hex');
}

// ---------- grants ----------

function activeGrants(grants, now = Date.now()) {
  return (grants || []).filter((g) => g && Number(g.expiresAt) > now);
}
// What leaves the laptop: the union of scopes and projects over active grants (default deny).
function unionOf(grants, now = Date.now()) {
  const act = activeGrants(grants, now);
  const scopes = new Set();
  const projects = new Set();
  for (const g of act) {
    for (const s of g.scopes || []) if (SCOPES.includes(s)) scopes.add(s);
    for (const p of g.projects || []) projects.add(p);
  }
  return { count: act.length, scopes: [...scopes], projects: projects.has('*') ? ['*'] : [...projects] };
}

// Relay data is shaped field by field before the UI sees it.
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
function cleanGrant(g) {
  if (!g || typeof g !== 'object') return null;
  const email = str(g.viewerEmail, 254);
  if (!email) return null;
  return {
    viewerEmail: email,
    viewerName: str(g.viewerName, 120),
    hasAccount: g.hasAccount === true,
    scopes: Array.isArray(g.scopes) ? g.scopes.filter((s) => SCOPES.includes(s)) : [],
    projects: Array.isArray(g.projects) ? g.projects.filter((p) => typeof p === 'string').map((p) => p.slice(0, 100)).slice(0, 50) : [],
    expiresAt: num(g.expiresAt),
    createdAt: num(g.createdAt),
    lastViewed: num(g.lastViewed),
  };
}
function cleanAuditRow(a) {
  if (!a || typeof a !== 'object') return null;
  return { ts: num(a.ts), who: str(a.who, 254), what: str(a.what, 300), result: str(a.result, 60), reason: str(a.reason, 120) };
}

function checkEmail(email, domain) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1 || e.slice(at + 1) !== domain || !/^[a-z0-9._%+-]+$/.test(e.slice(0, at))) throw new Error(`use a teammate's @${domain} email`);
  return e;
}

// ---------- relay client ----------

// The relay origin: https, or http on this computer for local development.
function checkRelayUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('invalid relay URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('the relay URL must be https');
  return url.origin;
}

class RelayError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

function createRelayClient(base, { fetchImpl = globalThis.fetch, timeoutMs = TIMING.request } = {}) {
  return async function request(method, p, { token, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new RelayError(0, 'the relay could not be reached');
    }
    const text = await res.text();
    let data = null;
    try { data = text.length <= 1024 * 1024 ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new RelayError(res.status, (data && str(data.error, 200)) || `relay error ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    return data || {};
  };
}

// Quota, rate limit, outage or network: back off instead of retrying.
const backoffWorthy = (e) => e instanceof RelayError && (e.status === 0 || e.status === 429 || e.status >= 500);

// ---------- state file (~/.ship-deck/share.json, 0600) ----------

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
function writeState(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- the share agent ----------

// opts: relayUrl, dir (the orders dir), readFleet() -> /api/fleet object, readExtras(needs) ->
// extras, home, hosts, domain (default keychain.com), fetchImpl, now, deviceName.
function createShareAgent(opts) {
  const base = checkRelayUrl(opts.relayUrl);
  const file = path.join(opts.dir, STATE_FILE);
  const now = opts.now || Date.now;
  const domain = opts.domain || 'keychain.com';
  const request = createRelayClient(base, { fetchImpl: opts.fetchImpl });
  // No hostname: it often carries a person's name, and the relay only needs to tell devices apart.
  const deviceName = cap(opts.deviceName || `Ship Deck on ${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[os.platform()] || os.platform()}`, 60);
  const log = opts.log || (() => {});

  let st = readState(file);
  if (!st.key) { st.key = crypto.randomBytes(32).toString('base64url'); save(); }
  let grants = null;
  let grantsAt = 0;
  let lastPushAt = 0;
  let lastHash = null;
  let lastBytes = 0;
  let force = false;
  let failures = 0;
  let retryAt = 0;
  let problem = null;
  let busy = false;
  let timer = null;
  const fm = { state: 'idle', since: null };
  let term = { at: 0, panes: {} };

  function save() { writeState(file, st); }
  function account() { return st.token && st.account ? { email: str(st.account.email, 254), name: str(st.account.name, 120) } : null; }

  function status() {
    const t = now();
    const u = unionOf(grants, t);
    let state = 'signed-out';
    if (account()) state = st.paused ? 'paused' : retryAt > t ? 'backoff' : u.count ? 'sharing' : 'idle';
    return {
      enabled: true, relay: base, domain, account: account(), state, paused: !!st.paused, problem,
      retryAt: retryAt > t ? retryAt : null, lastPushAt: lastPushAt || null, lastBytes,
      grants: grants || [], scopes: u.scopes, projects: u.projects, viewers: u.count,
      device: deviceName, timing: { minPushSec: TIMING.minPush / 1000, keepAliveSec: TIMING.keepAlive / 1000 },
    };
  }

  function fail(e) {
    if (e instanceof RelayError && e.status === 401) {
      // The relay no longer accepts this device: stop until the captain signs in again.
      delete st.token;
      save();
      problem = 'The relay signed this computer out. Sign in again to keep sharing.';
      return;
    }
    if (backoffWorthy(e)) {
      failures++;
      const wait = Math.min(TIMING.backoffMax, Math.max(e.retryAfter || 0, TIMING.backoffBase * 2 ** (failures - 1)));
      retryAt = now() + wait;
      problem = e.status === 429 || /quota|limit/i.test(e.message)
        ? 'Sharing paused: the relay is over its free limit.' : 'Sharing paused: the relay is unreachable.';
      log(`share: ${e.message}; retrying in ${Math.round(wait / 1000)} s`);
      return;
    }
    problem = e.message;
  }
  function ok() { failures = 0; retryAt = 0; problem = null; }

  function setGrants(list) {
    grants = (Array.isArray(list) ? list : []).map(cleanGrant).filter(Boolean);
    grantsAt = now();
  }

  // brief: the agent's own refresh (one Redis read on the relay); the Settings list asks for more.
  async function refreshGrants(brief) {
    const data = await request('GET', brief ? '/v1/grants?brief=1' : '/v1/grants', { token: st.token });
    setGrants(data.grants);
    return grants;
  }

  async function build(u) {
    const fleet = await opts.readFleet();
    const t = now();
    if (u.scopes.includes('terminal') && t - term.at >= TIMING.terminal) {
      const ids = ((fleet && fleet.tasks) || []).filter((x) => x.kind !== 'secondmate' && x.window && x.alive !== false && sharedProject(x.project, u.projects)).map((x) => x.id);
      term = { at: t, panes: {} };
      for (const id of ids) {
        try { term.panes[id] = { at: t, text: await opts.readTerminal(id) }; } catch { /* no window */ }
      }
    }
    const extras = opts.readExtras ? await opts.readExtras({ skills: u.scopes.includes('skills'), notes: u.scopes.includes('notes'), chat: u.scopes.includes('chat') }) : {};
    // First mate busy/idle, with the time it last changed.
    const state = extras.firstMateWorking ? 'working' : 'idle';
    if (state !== fm.state || !fm.since) { fm.state = state; fm.since = t; }
    return projectSnapshot(fleet, {
      scopes: u.scopes, projects: u.projects, key: st.key, home: opts.home, hosts: opts.hosts, now: t,
      extras: { ...extras, firstMate: { ...fm }, terminal: term.panes },
    });
  }

  // One step: push when the snapshot changed (at most every 30 s) or as a 10-minute keep-alive.
  async function tick() {
    if (busy) return 'busy';
    busy = true;
    try {
      if (!st.token || st.paused) return 'off';
      if (retryAt > now()) return 'backoff';
      if (!grants || now() - grantsAt >= TIMING.grants) {
        try { await refreshGrants(true); ok(); } catch (e) { fail(e); return 'error'; }
      }
      const u = unionOf(grants, now());
      if (!u.count) return 'idle';
      if (!force && now() - lastPushAt < TIMING.minPush) return 'wait';
      const snap = await build(u);
      const hash = snapshotHash(snap);
      if (!force && hash === lastHash && now() - lastPushAt < TIMING.keepAlive) return 'same';
      try {
        const res = await request('POST', '/v1/snapshot', { token: st.token, body: snap });
        if (res.grants) setGrants(res.grants);
        lastPushAt = now();
        lastHash = hash;
        lastBytes = sizeOf(snap);
        force = false;
        ok();
        return 'pushed';
      } catch (e) { fail(e); return 'error'; }
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    const loop = async () => {
      try { await tick(); } catch (e) { log('share: ' + e.message); }
      timer = setTimeout(loop, TIMING.tick);
      if (timer.unref) timer.unref();
    };
    timer = setTimeout(loop, 1000);
    if (timer.unref) timer.unref();
  }
  function stop() { clearTimeout(timer); timer = null; }

  // Captain actions from the Settings page. The password goes straight to the relay and is not kept.
  async function signIn({ email, password }) {
    const e = checkEmail(email, domain);
    if (typeof password !== 'string' || !password) throw new Error('enter your password');
    const data = await request('POST', '/v1/device/login', { body: { email: e, password, device: deviceName } });
    if (typeof data.token !== 'string' || !data.account) throw new Error('unexpected answer from the relay');
    st.token = data.token.slice(0, 2048);
    st.account = { email: str(data.account.email, 254), name: str(data.account.name, 120), sub: str(data.account.sub, 64) };
    delete st.paused;
    save();
    grants = null;
    ok();
    return status();
  }
  async function signOut() {
    if (st.token) {
      try { await request('DELETE', '/v1/device', { token: st.token }); } catch { /* signed out locally anyway */ }
    }
    delete st.token;
    delete st.account;
    save();
    grants = null;
    lastHash = null;
    return status();
  }
  function needToken() { if (!st.token) throw new RelayError(401, 'sign in first'); }
  async function listGrants() { needToken(); await refreshGrants(); return grants; }
  async function putGrant({ email, scopes, projects, days }) {
    needToken();
    const e = checkEmail(email, domain);
    const sc = (Array.isArray(scopes) ? scopes : DEFAULT_SCOPES).filter((s) => SCOPES.includes(s));
    if (!sc.length) throw new Error('choose at least one thing to share');
    const pr = (Array.isArray(projects) ? projects : []).filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, 100)).slice(0, 50);
    if (!pr.length) throw new Error('choose at least one project');
    const d = GRANT_DAYS.includes(Number(days)) ? Number(days) : 30;
    const data = await request('PUT', '/v1/grants/' + encodeURIComponent(e), { token: st.token, body: { scopes: sc, projects: pr, expiresAt: now() + d * 86400e3 } });
    setGrants(data.grants);
    force = true;
    return grants;
  }
  async function revoke(viewer) {
    needToken();
    const data = await request('DELETE', '/v1/grants/' + encodeURIComponent(String(viewer || '').slice(0, 254)), { token: st.token });
    setGrants(data.grants);
    force = true;
    return grants;
  }
  async function invite(email) {
    needToken();
    const data = await request('POST', '/v1/invites', { token: st.token, body: { email: checkEmail(email, domain) } });
    const link = str(data.link, 600);
    if (!link || !link.startsWith(base + '/')) throw new Error('unexpected answer from the relay');
    return { link, expiresAt: num(data.expiresAt), email: str(data.email, 254) };
  }
  async function audit(since) {
    needToken();
    const q = Number.isFinite(Number(since)) ? '?since=' + Number(since) : '';
    const data = await request('GET', '/v1/audit' + q, { token: st.token });
    return (Array.isArray(data.rows) ? data.rows : []).map(cleanAuditRow).filter(Boolean);
  }
  function setPaused(p) { st.paused = !!p; save(); if (!p) force = true; return status(); }
  async function preview({ scopes, projects }) {
    return build({ count: 1, scopes: (scopes || []).filter((s) => SCOPES.includes(s)), projects: projects || [] });
  }

  return { status, tick, start, stop, signIn, signOut, listGrants, putGrant, revoke, invite, audit, setPaused, preview, file };
}

module.exports = {
  SCOPES, DEFAULT_SCOPES, GRANT_DAYS, LIMITS, WORKER_KEYS, SNAPSHOT_KEYS, TIMING, STATE_FILE,
  workerRef, sharedProject, prOf, projectSnapshot, fitToCap, snapshotHash, activeGrants, unionOf,
  cleanGrant, cleanAuditRow, checkEmail, checkRelayUrl, createRelayClient, RelayError, createShareAgent,
};
