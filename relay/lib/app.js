'use strict';
// The Ship Deck relay: decks push redacted snapshots, captains manage grants, teammates read.
// Every route is listed in ROUTES below; viewer routes are GET only and nothing a viewer sends
// reaches a deck. Storage keys (all in one Redis):
//   user:<email> account   sess:<hash> session   cap:<sub> captain record (devices + grants)
//   snap:<sub> latest snapshot (1 h TTL)   vix:<email> captains sharing with an email
//   aud:<sub> / aud:auth append-only audit (90 days)   aseen:... 15-minute audit de-dupe
//   setup:used the one-time owner setup link was spent
const crypto = require('node:crypto');
const { createAuth, AuthError } = require('../auth');
const { MAX_FAILURES, LOCK_SEC } = require('../auth/password');
const { randomId, sha256 } = require('../auth/tokens');
const { sessionKey } = require('../auth/sessions');
const { sanitizeSnapshot, viewFor, MAX_BYTES } = require('./snapshot');
const { validateGrant, findGrant, checkAccess, GrantError } = require('./access');
const { StoreError } = require('./store');
const { HttpError, BASE_HEADERS, sendJson, readJson, clientIp, sameOrigin, bearer } = require('./http');

const SNAP_TTL = 3600;
const AUDIT_DAYS = 90;
const AUDIT_TTL = AUDIT_DAYS * 86400;
const SEEN_TTL = 900; // repeat views of the same thing collapse into one audit row per 15 minutes
const MAX_DEVICES = 10;
const SCOPE_LABEL = { board: 'Board', updates: 'Updates', model: 'Model and effort', skills: 'Skills', terminal: 'Terminal', notes: 'Notes and memory', chat: 'Chat and activity' };
const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

function createRelay({ config, store, now = Date.now, log = (m) => console.error(m) }) {
  const auth = createAuth({ store, config, now, onEvent: authEvent });

  // ---------- audit (append-only: ZADD rows, trimmed only by age) ----------
  function auditCmds(sub, row) {
    const t = now();
    return [['ZADD', 'aud:' + sub, t, JSON.stringify({ id: randomId(6), ts: t, ...row })], ['EXPIRE', 'aud:' + sub, AUDIT_TTL]];
  }
  async function listAudit(key, since, limit = 500) {
    const floor = now() - AUDIT_DAYS * 86400e3;
    const [, rows] = await store.pipeline([
      ['ZREMRANGEBYSCORE', key, '-inf', floor],
      ['ZREVRANGEBYSCORE', key, '+inf', Math.max(floor, Number(since) || 0), 'LIMIT', 0, limit],
    ]);
    return (rows || []).map(parse).filter(Boolean);
  }
  const AUTH_TEXT = {
    login: ['Signed in', 'ok'], 'login-failed': ['Sign-in attempt', 'refused', 'wrong email or password'],
    locked: ['Sign-in attempt', 'refused', 'locked for 15 minutes'], invited: ['Invite link created', 'ok'],
    'account-created': ['Account created from an invite', 'ok'], 'password-reset': ['Password set from a new invite', 'ok'],
  };
  async function authEvent({ type, email, ip, sub }) {
    const [what, result, reason] = AUTH_TEXT[type] || [type, 'ok'];
    const row = { who: email, what, result, reason };
    const cmds = auditCmds('auth', { ...row, ip });
    if (sub && type !== 'invited') cmds.push(...auditCmds(sub, row));
    await store.pipeline(cmds);
  }

  // ---------- helpers ----------
  async function loadCap(sub) { return parse(await store.cmd(['GET', 'cap:' + sub])); }
  const saveCap = (cap) => ['SET', 'cap:' + cap.sub, JSON.stringify(cap)];

  // Deck routes: a deck token whose device still exists in the captain's record.
  async function deckAuth(req) {
    const claims = auth.verifyDeckToken(bearer(req));
    if (!claims) throw new HttpError(401, 'sign in from Ship Deck settings');
    const cap = await loadCap(claims.sub);
    if (!cap || !cap.devices || !cap.devices[claims.dev]) throw new HttpError(401, 'this device was signed out');
    return { cap, dev: claims.dev };
  }
  async function viewerAuth(req) {
    const viewer = await auth.sessions.get(auth.readCookie(req));
    if (!viewer) throw new HttpError(401, 'sign in');
    return viewer;
  }

  function briefGrants(cap) {
    return Object.values(cap.grants || {}).map((g) => ({ viewerEmail: g.viewerEmail, scopes: g.scopes, projects: g.projects, expiresAt: g.expiresAt, createdAt: g.createdAt }));
  }
  // The Settings page list: adds whether the teammate has an account and when they last looked.
  async function fullGrants(cap) {
    const list = briefGrants(cap);
    if (!list.length) return list;
    const [rows, users] = await store.pipeline([
      ['ZREVRANGEBYSCORE', 'aud:' + cap.sub, '+inf', now() - 30 * 86400e3, 'LIMIT', 0, 500],
      ['MGET', ...list.map((g) => 'user:' + g.viewerEmail)],
    ]);
    const last = {};
    for (const r of (rows || []).map(parse)) if (r && r.result === 'viewed' && r.who && !last[r.who]) last[r.who] = r.ts;
    return list.map((g, i) => {
      const u = parse(users[i]);
      return { ...g, hasAccount: !!u, viewerName: u ? u.name : null, lastViewed: last[g.viewerEmail] || null };
    });
  }

  // True when any account exists. SCAN, not KEYS: user:* keys have no index of their own.
  async function hasAccounts() {
    let cursor = '0';
    do {
      const [next, keys] = await store.cmd(['SCAN', cursor, 'MATCH', 'user:*', 'COUNT', 1000]);
      if (keys && keys.length) return true;
      cursor = String(next);
    } while (cursor !== '0');
    return false;
  }
  // Hashing first gives equal-length buffers, so the compare leaks neither content nor length.
  const codeMatches = (got, want) => crypto.timingSafeEqual(Buffer.from(sha256(String(got))), Buffer.from(sha256(want)));

  // GET /api/auth/setup?code=: the first captain's one-time link. Every refusal is the same 404;
  // wrong codes count toward the per-IP login lockout. Never logs the code or the invite token.
  async function ownerSetup(req, res, url) {
    req.resume();
    const notFound = () => sendJson(res, 404, { error: 'not found' });
    if (config.setupCode.length < 32 || !config.ownerEmail || !auth.emailAllowed(config.ownerEmail) || !auth.provider.createInvite) return notFound();
    const ip = clientIp(req, config.trustProxy);
    const ki = 'fail:ip:' + ip;
    const [used, fails] = await store.cmd(['MGET', 'setup:used', ki]);
    if (used || (await hasAccounts())) return notFound();
    const audit = (result, reason) => store.pipeline(auditCmds('auth', { who: 'owner setup link', what: 'Owner setup link opened', result, reason, ip }));
    if (Number(fails) >= MAX_FAILURES) { await audit('refused', 'locked for 15 minutes'); return notFound(); }
    if (!codeMatches(url.searchParams.get('code') || '', config.setupCode)) {
      const [n] = await store.pipeline([['INCR', ki], ['EXPIRE', ki, LOCK_SEC]]);
      await audit('refused', Number(n) >= MAX_FAILURES ? 'wrong code, locked for 15 minutes' : 'wrong code');
      return notFound();
    }
    // NX makes the link single-use even when two clicks race.
    if ((await store.cmd(['SET', 'setup:used', String(now()), 'NX'])) !== 'OK') return notFound();
    const inv = await auth.provider.createInvite({ email: config.ownerEmail, by: 'setup' });
    await audit('ok', 'invite created for ' + inv.email);
    res.writeHead(302, { ...BASE_HEADERS, Location: inv.link, 'Content-Length': 0 });
    res.end();
  }

  function sessionCookieHeaders(id) { return { 'Set-Cookie': auth.sessions.cookie(id) }; }
  function guardCookiePost(req) {
    if (!sameOrigin(req, config.baseUrl)) throw new HttpError(403, 'cross-site request refused');
  }

  // ---------- routes ----------
  const ROUTES = [
    // Browser sign-in (cookie). Invite-only: there is no sign-up route.
    ['/api/auth/login', {
      POST: async (req, res) => {
        guardCookiePost(req);
        const b = await readJson(req, 4096);
        const who = await auth.provider.login({ email: b.email, password: b.password, ip: clientIp(req, config.trustProxy) });
        const id = await auth.sessions.create(who);
        sendJson(res, 200, { ok: true, viewer: { email: who.email, name: who.name } }, sessionCookieHeaders(id));
      },
    }],
    ['/api/auth/setup', { GET: ownerSetup }],
    ['/api/auth/logout', {
      POST: async (req, res) => {
        guardCookiePost(req);
        const id = auth.readCookie(req);
        const viewer = await auth.sessions.get(id);
        await auth.sessions.destroy(id, viewer && viewer.sub);
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.sessions.clearCookie() });
      },
    }],
    ['/api/auth/accept', {
      POST: async (req, res) => {
        guardCookiePost(req);
        if (!auth.provider.acceptInvite) throw new HttpError(404, 'not found');
        const b = await readJson(req, 4096);
        const who = await auth.provider.acceptInvite({ token: b.token, password: b.password, destroyAllSessions: auth.sessions.destroyAll });
        const id = await auth.sessions.create(who);
        sendJson(res, 200, { ok: true, viewer: { email: who.email, name: who.name } }, sessionCookieHeaders(id));
      },
    }],
    // A deck signs in once with the captain's password and keeps a revocable device token.
    ['/v1/device/login', {
      POST: async (req, res) => {
        const b = await readJson(req, 4096);
        const who = await auth.provider.login({ email: b.email, password: b.password, ip: clientIp(req, config.trustProxy) });
        const cap = (await loadCap(who.sub)) || { sub: who.sub, devices: {}, grants: {} };
        Object.assign(cap, { email: who.email, name: who.name });
        const dev = randomId(12);
        const name = typeof b.device === 'string' && b.device.trim() ? b.device.trim().slice(0, 60) : 'Ship Deck';
        cap.devices[dev] = { name, createdAt: now() };
        const ids = Object.keys(cap.devices).sort((x, y) => cap.devices[y].createdAt - cap.devices[x].createdAt);
        for (const old of ids.slice(MAX_DEVICES)) delete cap.devices[old];
        await store.pipeline([saveCap(cap), ...auditCmds(cap.sub, { who: who.email, what: `Signed in ${name}`, result: 'linked' })]);
        sendJson(res, 200, { token: auth.signDeckToken({ sub: cap.sub, dev }), account: { sub: cap.sub, email: cap.email, name: cap.name } });
      },
    }],
    ['/v1/device', {
      DELETE: async (req, res) => {
        const { cap, dev } = await deckAuth(req);
        const name = cap.devices[dev].name;
        delete cap.devices[dev];
        await store.pipeline([saveCap(cap), ...auditCmds(cap.sub, { who: cap.email, what: `Signed out ${name}`, result: 'unlinked' })]);
        sendJson(res, 200, { ok: true });
      },
    }],
    ['/v1/invites', {
      POST: async (req, res) => {
        const { cap } = await deckAuth(req);
        if (!auth.provider.createInvite) throw new HttpError(404, 'not found');
        const b = await readJson(req, 2048);
        const inv = await auth.provider.createInvite({ email: b.email, by: cap.sub });
        await store.pipeline(auditCmds(cap.sub, { who: cap.email, what: `Created an invite link for ${inv.email}`, result: 'invited' }));
        sendJson(res, 200, inv);
      },
    }],
    ['/v1/snapshot', {
      POST: async (req, res) => {
        const { cap } = await deckAuth(req);
        const body = await readJson(req, MAX_BYTES + 8 * 1024);
        let snap;
        try { snap = sanitizeSnapshot(body, now()); } catch (e) { throw new HttpError(400, e.message); }
        await store.cmd(['SET', 'snap:' + cap.sub, JSON.stringify({ at: now(), name: cap.name, snap }), 'EX', SNAP_TTL]);
        sendJson(res, 200, { ok: true, grants: briefGrants(cap) });
      },
    }],
    ['/v1/grants', {
      GET: async (req, res, url) => {
        const { cap } = await deckAuth(req);
        sendJson(res, 200, { grants: url.searchParams.has('brief') ? briefGrants(cap) : await fullGrants(cap) });
      },
    }],
    [/^\/v1\/grants\/([^/]+)$/, {
      PUT: async (req, res, url, m) => {
        const { cap } = await deckAuth(req);
        const b = await readJson(req, 8192);
        const email = auth.normalizeEmail(decodeURIComponent(m[1]));
        const g = validateGrant(email, b, { domain: config.domain, captainEmail: cap.email, now: now(), previous: cap.grants[email] });
        cap.grants[g.viewerEmail] = g;
        const what = `Gave ${g.viewerEmail} ${g.scopes.map((s) => SCOPE_LABEL[s]).join(', ')} until ${new Date(g.expiresAt).toISOString().slice(0, 10)}`;
        await store.pipeline([saveCap(cap), ['SADD', 'vix:' + g.viewerEmail, cap.sub], ...auditCmds(cap.sub, { who: cap.email, what, result: 'granted' })]);
        sendJson(res, 200, { ok: true, grants: await fullGrants(cap) });
      },
      DELETE: async (req, res, url, m) => {
        const { cap } = await deckAuth(req);
        const key = decodeURIComponent(m[1]).toLowerCase();
        const email = Object.keys(cap.grants).find((e) => e === key || (cap.grants[e].viewerSub || '').toLowerCase() === key);
        if (!email) throw new HttpError(404, 'no such grant');
        delete cap.grants[email];
        await store.pipeline([saveCap(cap), ['SREM', 'vix:' + email, cap.sub], ...auditCmds(cap.sub, { who: cap.email, what: `Revoked access for ${email}`, result: 'revoked' })]);
        sendJson(res, 200, { ok: true, grants: await fullGrants(cap) });
      },
    }],
    ['/v1/audit', {
      GET: async (req, res, url) => {
        const { cap } = await deckAuth(req);
        const since = url.searchParams.get('since');
        let rows = await listAudit('aud:' + cap.sub, since);
        // The relay owner also sees every sign-in attempt.
        if (config.ownerEmail && cap.email === config.ownerEmail) rows = rows.concat(await listAudit('aud:auth', since)).sort((a, b) => b.ts - a.ts).slice(0, 500);
        sendJson(res, 200, { rows: rows.map((r) => ({ ts: r.ts, who: r.who, what: r.what, result: r.result, reason: r.reason || null })) });
      },
    }],
    // ---------- viewer: GET only ----------
    ['/v1/decks', {
      GET: async (req, res) => {
        const viewer = await viewerAuth(req);
        const subs = (await store.cmd(['SMEMBERS', 'vix:' + viewer.email])) || [];
        const decks = [];
        if (subs.length) {
          const vals = await store.cmd(['MGET', ...subs.map((s) => 'cap:' + s), ...subs.map((s) => 'snap:' + s)]);
          subs.forEach((s, i) => {
            const cap = parse(vals[i]);
            const g = findGrant(cap, viewer);
            if (!g || !(g.expiresAt > now())) return;
            const snap = parse(vals[subs.length + i]);
            const board = snap ? viewFor(snap.snap, g, 'board') : null;
            decks.push({
              captainSub: s, name: cap.name, email: cap.email, at: snap ? snap.at : null, offline: !snap,
              workers: board && board.data ? board.data.workers.length : null,
              grant: { scopes: g.scopes, projects: g.projects, expiresAt: g.expiresAt },
            });
          });
        }
        sendJson(res, 200, { viewer: { email: viewer.email, name: viewer.name }, decks });
      },
    }],
    [/^\/v1\/decks\/([A-Za-z0-9_-]{8,40})\/([a-z]{2,12})$/, {
      GET: async (req, res, url, m) => viewDeck(req, res, url, m[1], m[2]),
    }],
  ];

  // One MGET per view: the session, the snapshot, the captain record and the de-dupe marker.
  async function viewDeck(req, res, url, capSub, scope) {
    const id = auth.readCookie(req);
    if (!id) throw new HttpError(401, 'sign in');
    const ref = url.searchParams.get('ref') || '';
    if (ref && !/^[A-Za-z0-9_-]{8,32}$/.test(ref)) throw new HttpError(400, 'bad ref');
    const seenKey = `aseen:${capSub}:${sha256(id).slice(0, 16)}:${scope}:${ref || '-'}`;
    const [rawSess, rawSnap, rawCap, seen] = await store.cmd(['MGET', sessionKey(id), 'snap:' + capSub, 'cap:' + capSub, seenKey]);
    const viewer = auth.sessions.check(rawSess);
    if (!viewer) throw new HttpError(401, 'sign in');
    const cap = parse(rawCap);
    if (!cap) throw new HttpError(404, 'no such deck');
    const stored = parse(rawSnap);
    let access = checkAccess({ cap, viewer, scope, domain: config.domain, now: now() });
    let view = null;
    // The captain's audit names the worker asked about, even on a refusal.
    const worker = ref && stored ? stored.snap.workers.find((w) => w.ref === ref) || null : null;
    if (access.ok && stored) {
      view = viewFor(stored.snap, access.grant, scope, ref || undefined);
      if (view.refused === 'project not shared') access = { ok: false, reason: view.refused };
      else if (view.refused) throw new HttpError(404, 'not found');
    }
    const result = access.ok ? 'viewed' : 'refused';
    const cmds = [];
    if (seen !== result + ':' + (access.reason || '')) {
      const what = (worker && worker.title ? worker.title + ', ' : '') + (SCOPE_LABEL[scope] || scope);
      cmds.push(['SET', seenKey, result + ':' + (access.reason || ''), 'EX', SEEN_TTL], ...auditCmds(capSub, { who: viewer.email, what, result, reason: access.reason || null }));
    }
    if (access.ok && !access.grant.viewerSub) {
      access.grant.viewerSub = viewer.sub; // bind the grant to this person on first use
      cmds.push(saveCap(cap));
    }
    if (cmds.length) await store.pipeline(cmds);
    if (!access.ok) return sendJson(res, 403, { error: access.reason });
    const g = access.grant;
    const head = { captain: { sub: capSub, name: cap.name }, grant: { scopes: g.scopes, projects: g.projects, expiresAt: g.expiresAt } };
    if (!stored) return sendJson(res, 200, { ...head, offline: true, at: null });
    sendJson(res, 200, { ...head, offline: false, at: stored.at, ...view.data });
  }

  // ---------- dispatch ----------
  return async function handle(req, res) {
    const url = new URL(req.url, config.baseUrl || 'http://localhost');
    // Vercel rewrites pass the original path in __r (see vercel.json).
    const p = url.searchParams.get('__r') || url.pathname;
    try {
      for (const [pat, methods] of ROUTES) {
        const m = typeof pat === 'string' ? (p === pat ? [p] : null) : pat.exec(p);
        if (!m) continue;
        const fn = methods[req.method];
        if (!fn) { req.resume(); return sendJson(res, 405, { error: 'method not allowed' }, { Allow: Object.keys(methods).join(', ') }); }
        return await fn(req, res, url, m);
      }
      req.resume();
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof URIError) return sendJson(res, 400, { error: 'bad path' });
      if (e instanceof AuthError) return sendJson(res, e.status, { error: e.message }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
      if (e instanceof HttpError || e instanceof GrantError) return sendJson(res, e.status, { error: e.message }, e.headers || {});
      if (e instanceof StoreError && e.quota) {
        log('relay: store over its free limit');
        return sendJson(res, 503, { error: 'quota' }, { 'Retry-After': '900' });
      }
      log('relay: ' + (e && e.message)); // messages only; bodies and passwords are never logged
      sendJson(res, e instanceof StoreError ? 503 : 500, { error: 'relay error' }, { 'Retry-After': '60' });
    }
  };
}

module.exports = { createRelay, SNAP_TTL, AUDIT_DAYS, SEEN_TTL, SCOPE_LABEL };
