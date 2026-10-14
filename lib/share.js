'use strict';
// Read-only teammate sharing, deck side (opt-in with --share). An allow-listed, redacted projection
// of /api/fleet is pushed outbound over HTTPS to the Keychain relay (relay/); nothing listens for
// the relay. Everything read back from the relay is data: this module never requires orders, wake
// or actions, so no relay response can become an order or an fm-send (test/share.test.js checks).
// The other direction: knowledge teammates share with this account becomes lib/knowledge.js skills.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const board = require('../public/board');
const { redact, stripAnsi, cap, DEFAULT_HOSTS } = require('./redact');
const knowledge = require('./knowledge');

// skills and notes also share their full text as knowledge the teammate's own agent uses (the
// library projection below). An old agentLibrary flag on a grant is ignored.
const SCOPES = ['board', 'updates', 'model', 'skills', 'terminal', 'notes', 'chat'];
const DEFAULT_SCOPES = ['board', 'updates', 'model'];
const GRANT_DAYS = [1, 7, 30];
const STATE_FILE = 'share.json';
const LIMITS = {
  title: 120, summary: 200, option: 200, note: 200, terminalLines: 40, terminalLine: 240,
  noteText: 8000, chatText: 500, chatItems: 30, activityItems: 30, skills: 100, snapshot: 64 * 1024,
  libraryText: 16000, libraryItems: 150, library: 200 * 1024,
};
// The knowledge library projection: only these keys per item (relay/lib/library.js re-applies them).
const LIBRARY_ITEM_KEYS = ['key', 'title', 'description', 'text'];
const LIBRARY_KEY_RE = /^(?:skill|memory|home):[A-Za-z0-9_.:/-]{1,110}$/;
// Exactly what may leave the laptop (Appendix D). The relay re-applies the same lists.
const WORKER_KEYS = ['ref', 'id', 'title', 'project', 'state', 'quietDays', 'summary', 'updatedAt', 'options', 'pr', 'model', 'effort'];
const SNAPSHOT_KEYS = ['v', 'at', 'scopes', 'projects', 'hiddenProjects', 'fleet', 'workers', 'updates', 'terminal', 'skills', 'notes', 'chat', 'activity', 'trimmed'];
// Dropped first when a snapshot is over 64 KB.
const TRIM_ORDER = ['terminal', 'notes', 'activity', 'chat', 'updates', 'skills'];
const TIMING = {
  tick: 10e3, minPush: 30e3, keepAlive: 10 * 60e3, terminal: 30e3, grants: 10 * 60e3,
  backoffBase: 30e3, backoffMax: 15 * 60e3, request: 10e3, library: 60e3, libraryKeepAlive: 60 * 60e3,
  knowledge: 10 * 60e3, knowledgeBackoffMax: 60 * 60e3,
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

// The knowledge library projection: skills (unless opts.skills is false) and notes (opts.notes)
// with their full markdown, redacted like every other shared text. entries: [{ key, title,
// description, text }] from the deck's library reader. Items past LIMITS.library are left out.
function projectLibrary(entries, opts = {}) {
  const rx = { home: opts.home, hosts: opts.hosts || DEFAULT_HOSTS };
  const r = (v, max) => cap(redact(v, rx), max);
  const out = { v: 1, items: [], trimmed: 0 };
  let total = 0;
  for (const e of entries || []) {
    if (!e || typeof e.key !== 'string' || !LIBRARY_KEY_RE.test(e.key)) continue;
    if (e.key.startsWith('skill:') ? opts.skills === false : !opts.notes) continue;
    if (out.items.length >= LIMITS.libraryItems) { out.trimmed++; continue; }
    const item = { key: e.key, title: r(e.title || e.key, 120), description: r(e.description || '', 300), text: r(e.text || '', LIMITS.libraryText) };
    const size = sizeOf(item);
    if (total + size > (opts.maxBytes || LIMITS.library)) { out.trimmed++; continue; }
    total += size;
    out.items.push(item);
  }
  return out;
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

// What the knowledge library needs: skills when any active grant has skills, notes when any has
// notes (the relay filters per grant again).
function libraryNeeds(grants, now = Date.now()) {
  const act = activeGrants(grants, now);
  const has = (s) => act.some((g) => (g.scopes || []).includes(s));
  const skills = has('skills');
  const notes = has('notes');
  return { on: skills || notes, skills, notes };
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

// A /v1/knowledge deck and a /v1/knowledge/<sub> item, shaped before anything is written.
const SUB_RE = /^[A-Za-z0-9_-]{8,40}$/;
function cleanKnowledgeDeck(d) {
  if (!d || typeof d !== 'object' || !SUB_RE.test(d.captainSub)) return null;
  return { captainSub: d.captainSub, name: str(d.name, 120), hash: str(d.hash, 64), offline: d.offline === true, skills: d.skills === true, notes: d.notes === true, expiresAt: num(d.expiresAt) };
}
function cleanKnowledgeItem(i) {
  if (!i || typeof i !== 'object' || typeof i.key !== 'string' || !LIBRARY_KEY_RE.test(i.key)) return null;
  return { key: i.key, kind: i.key.startsWith('skill:') ? 'skill' : 'note', title: str(i.title, 120) || i.key, description: str(i.description, 300) || '', text: str(i.text, LIMITS.libraryText) || '' };
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
// extras, readLibrary(needs) -> entries, skillsDir (where teammates' knowledge is written; none:
// no sync), home, hosts, domain (default keychain.com), fetchImpl, now, deviceName.
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
  const lib = { checkedAt: 0, pushedAt: 0, hash: null, on: false };
  // Knowledge shared with me: st.useKnowledge (default on), st.knowledge { captainSub: { name, slug, hash } }.
  // version: the relay's knowledge version at the last full list; seen: the newest one any deck
  // answer carried (grant refreshes and pushes include it), so most checks need no request.
  const kn = { checkedAt: 0, failures: 0, retryAt: 0, problem: null, lastAt: 0, version: null, seen: null, until: Infinity };
  const resetKnowledge = () => Object.assign(kn, { checkedAt: 0, retryAt: 0, failures: 0, problem: null, version: null, seen: null });
  function sawVersion(data) { if (data && typeof data.knowledge === 'string') kn.seen = { v: data.knowledge.slice(0, 40), at: now() }; }
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
      knowledge: knowledgeStatus(),
    };
  }

  // The Settings list: what is on disk now, grouped by teammate.
  function knowledgeStatus() {
    const decks = {};
    for (const m of opts.skillsDir ? knowledge.listTeammateSkills(opts.skillsDir) : []) {
      const d = decks[m.captainSub] || (decks[m.captainSub] = { captainSub: m.captainSub, name: m.captain, syncedAt: null, skills: [], notes: false });
      if (m.kind === 'notes') d.notes = true;
      else d.skills.push({ dir: m.dir, title: m.title });
      d.syncedAt = Math.max(d.syncedAt || 0, m.syncedAt || 0) || null;
    }
    return { available: !!opts.skillsDir, on: st.useKnowledge !== false, lastSyncAt: kn.lastAt || null, problem: kn.problem, retryAt: kn.retryAt > now() ? kn.retryAt : null, decks: Object.values(decks) };
  }

  function fail(e) {
    if (e instanceof RelayError && e.status === 401) {
      // The relay no longer accepts this device: stop until the captain signs in again.
      delete st.token;
      clearKnowledge();
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
    sawVersion(data);
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
      if (!st.token) return 'off';
      // Knowledge sync runs even while sharing is paused; the grant refresh first, so its
      // knowledge version is fresh when the sync looks at it.
      if (!st.paused && retryAt <= now() && (!grants || now() - grantsAt >= TIMING.grants)) {
        try { await refreshGrants(true); ok(); } catch (e) { fail(e); return 'error'; }
      }
      await syncKnowledge();
      if (!st.token || st.paused) return 'off';
      if (retryAt > now()) return 'backoff';
      await syncLibrary();
      const u = unionOf(grants, now());
      if (!u.count) return 'idle';
      if (!force && now() - lastPushAt < TIMING.minPush) return 'wait';
      const snap = await build(u);
      const hash = snapshotHash(snap);
      if (!force && hash === lastHash && now() - lastPushAt < TIMING.keepAlive) return 'same';
      try {
        const res = await request('POST', '/v1/snapshot', { token: st.token, body: snap });
        if (res.grants) setGrants(res.grants);
        sawVersion(res);
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

  // Knowledge shared with me, into teammate skills. At most every 10 minutes: nothing to ask when
  // a fresh deck answer showed the same version; else one version check (1 Redis command), the
  // hash list when it moved, and the full text only for a teammate whose hash changed. A grant
  // end also re-lists. Errors back off on their own clock (20 min doubling to an hour).
  async function syncKnowledge() {
    if (!opts.skillsDir || !st.token) return 'off';
    if (st.useKnowledge === false) { clearKnowledge(); return 'off'; }
    const t = now();
    if (t < kn.retryAt || (kn.checkedAt && t - kn.checkedAt < TIMING.knowledge)) return 'wait';
    kn.checkedAt = t;
    const current = kn.version !== null && t < kn.until;
    if (current && kn.seen && kn.seen.v === kn.version && t - kn.seen.at < TIMING.knowledge) { kn.lastAt = t; return 'same'; }
    try {
      const list = await request('GET', '/v1/knowledge' + (current ? '?since=' + encodeURIComponent(kn.version) : ''), { token: st.token });
      if (list.same) { kn.lastAt = t; Object.assign(kn, { failures: 0, problem: null }); return 'same'; }
      const decks = (Array.isArray(list.decks) ? list.decks : []).map(cleanKnowledgeDeck).filter(Boolean);
      const known = st.knowledge || {};
      const slugs = knowledge.captainSlugs(decks, Object.fromEntries(Object.entries(known).map(([k, v]) => [k, v && v.slug])));
      const onDisk = new Set(knowledge.listTeammateSkills(opts.skillsDir).map((m) => m.captainSub));
      const next = {};
      for (const d of decks) {
        const prev = known[d.captainSub];
        // The captain's deck is offline (their library expired on the relay): keep what we have.
        if (d.offline) { if (prev) next[d.captainSub] = prev; continue; }
        if (prev && prev.hash === d.hash && prev.slug === slugs[d.captainSub] && onDisk.has(d.captainSub)) { next[d.captainSub] = prev; continue; }
        let full;
        try { full = await request('GET', '/v1/knowledge/' + d.captainSub, { token: st.token }); } catch (e) {
          if (e instanceof RelayError && e.status === 403) continue; // access ended since the list
          throw e;
        }
        const name = str(full.captain && full.captain.name, 120) || d.name;
        const deck = { captainSub: d.captainSub, name, items: (Array.isArray(full.items) ? full.items : []).map(cleanKnowledgeItem).filter(Boolean) };
        const taken = knowledge.takenDirs(opts.skillsDir, d.captainSub);
        knowledge.writeDeck(opts.skillsDir, deck, knowledge.planDeck(deck, slugs[d.captainSub], t, taken), t);
        next[d.captainSub] = { name, slug: slugs[d.captainSub], hash: str(full.hash, 64) || d.hash };
      }
      // Revoked, expired or no longer sharing skills or notes: their directories go.
      knowledge.removeTeammateSkills(opts.skillsDir, (m) => !next[m.captainSub]);
      st.knowledge = next;
      save();
      const ends = decks.map((d) => d.expiresAt).filter((x) => x > t);
      Object.assign(kn, { failures: 0, retryAt: 0, problem: null, lastAt: t, version: str(list.version, 40), until: ends.length ? Math.min(...ends) : Infinity });
      return 'synced';
    } catch (e) {
      if (e instanceof RelayError && e.status === 401) { fail(e); return 'error'; }
      kn.failures++;
      kn.retryAt = t + Math.min(TIMING.knowledgeBackoffMax, TIMING.knowledge * 2 ** kn.failures);
      kn.problem = `Could not fetch what teammates share with you: ${e.message}.`;
      log('share: knowledge: ' + e.message);
      return 'error';
    }
  }
  // Takes every synced teammate skill off this computer (toggle off, sign-out).
  function clearKnowledge() {
    if (opts.skillsDir) knowledge.removeTeammateSkills(opts.skillsDir);
    if (st.knowledge && Object.keys(st.knowledge).length) { st.knowledge = {}; save(); }
  }
  function setKnowledge(on) {
    st.useKnowledge = !!on;
    if (!on) clearKnowledge();
    resetKnowledge();
    save();
    return status();
  }

  // The knowledge library rides beside the snapshot: checked every minute, pushed when it changes
  // (or hourly so the relay keeps it), deleted from the relay when no grant needs it any more.
  // Failures here never stop the snapshot; they wait for the next check.
  async function syncLibrary() {
    if (now() - lib.checkedAt < TIMING.library) return;
    lib.checkedAt = now();
    const need = libraryNeeds(grants, now());
    try {
      if (!need.on || !opts.readLibrary) {
        if (lib.on) { await request('DELETE', '/v1/library', { token: st.token }); lib.on = false; lib.hash = null; }
        return;
      }
      const proj = projectLibrary(await opts.readLibrary({ skills: need.skills, notes: need.notes }), { skills: need.skills, notes: need.notes, home: opts.home, hosts: opts.hosts });
      const hash = crypto.createHash('sha256').update(JSON.stringify(proj)).digest('hex');
      if (lib.on && hash === lib.hash && now() - lib.pushedAt < TIMING.libraryKeepAlive) return;
      await request('POST', '/v1/library', { token: st.token, body: proj });
      Object.assign(lib, { on: true, hash, pushedAt: now() });
    } catch (e) {
      log('share: library: ' + e.message);
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
    resetKnowledge();
    ok();
    return status();
  }
  // Takes the knowledge library off the relay (pause, sign-out); best effort, it also expires there.
  async function dropLibrary() {
    if (!lib.on || !st.token) return;
    lib.on = false;
    lib.hash = null;
    try { await request('DELETE', '/v1/library', { token: st.token }); } catch (e) { log('share: library: ' + e.message); }
  }
  async function signOut() {
    if (st.token) {
      await dropLibrary();
      try { await request('DELETE', '/v1/device', { token: st.token }); } catch { /* signed out locally anyway */ }
    }
    delete st.token;
    delete st.account;
    // Without a session the grants behind them cannot be checked: teammate skills go too.
    clearKnowledge();
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
    lib.checkedAt = 0;
    return grants;
  }
  async function revoke(viewer) {
    needToken();
    const data = await request('DELETE', '/v1/grants/' + encodeURIComponent(String(viewer || '').slice(0, 254)), { token: st.token });
    setGrants(data.grants);
    force = true;
    lib.checkedAt = 0;
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
  function setPaused(p) {
    st.paused = !!p;
    save();
    if (!p) { force = true; lib.checkedAt = 0; } else dropLibrary();
    return status();
  }
  async function preview({ scopes, projects }) {
    return build({ count: 1, scopes: (scopes || []).filter((s) => SCOPES.includes(s)), projects: projects || [] });
  }

  return { status, tick, start, stop, signIn, signOut, listGrants, putGrant, revoke, invite, audit, setPaused, setKnowledge, syncKnowledge, preview, file };
}

module.exports = {
  SCOPES, DEFAULT_SCOPES, GRANT_DAYS, LIMITS, WORKER_KEYS, SNAPSHOT_KEYS, LIBRARY_ITEM_KEYS, LIBRARY_KEY_RE, TIMING, STATE_FILE,
  workerRef, sharedProject, prOf, projectSnapshot, projectLibrary, libraryNeeds, fitToCap, snapshotHash, activeGrants, unionOf,
  cleanGrant, cleanAuditRow, cleanKnowledgeDeck, cleanKnowledgeItem, checkEmail, checkRelayUrl, createRelayClient, RelayError, createShareAgent,
};
