#!/usr/bin/env node
'use strict';
// Ship Deck: a live view of a firstmate fleet and the captain's control surface.
//   node server.js [--home <FM_HOME>] [--port 4747] [--stale-days 7] [--no-tmux] [--no-open]
//                  [--orders-dir ~/.ship-deck] [--memory-dir <dir>] [--claude-dir ~/.claude]
//                  [--captain-name <name>] [--share --share-relay <https url> | --no-share]
// Binds to 127.0.0.1 only. Writes to FM_HOME only one wake line per order (lib/wake.js,
// --no-wake); other file writes go to the orders dir (~/.ship-deck). The only commands run are tmux list-windows,
// tmux capture-pane and <home>/bin/fm-send.sh (see lib/actions.js), plus the browser opener at startup.
// --share (off here; the installed launcher turns it on unless install.sh --no-share) adds one
// outbound HTTPS client: lib/share.js pushes a redacted snapshot.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { buildSnapshot, reportPath, readText, parseMeta, DEFAULT_STALE_DAYS } = require('./lib/fleet');
const orders = require('./lib/orders');
const wake = require('./lib/wake');
const actions = require('./lib/actions');
const library = require('./lib/library');
const sessions = require('./lib/sessions');
const config = require('./lib/config');
const attachments = require('./lib/attachments');
const activity = require('./lib/activity');
const homes = require('./lib/home');
const share = require('./lib/share');

const DEFAULT_PORT = 4747;
const PORT_TRIES = 20;
const MAX_BODY = 16 * 1024;
const ORDERS_IN_SNAPSHOT = 60;
const THREAD_LIMIT = 300;
const POST_ROUTES = new Set(['/api/send', '/api/orders', '/api/config']);
const SHARE_POST = new Set(['/api/share/signin', '/api/share/signout', '/api/share/grant', '/api/share/revoke', '/api/share/invite', '/api/share/pause', '/api/share/knowledge']);
// Library files a "notes and memory" grant may carry (plus memory/*).
const SHARE_NOTES = ['home:data/captain.md', 'home:data/captain-shared.md', 'home:data/learnings.md'];
const USAGE = 'usage: ship-deck [--home FM_HOME] [--port 4747] [--stale-days 7] [--no-tmux] [--no-open] [--orders-dir DIR] [--memory-dir DIR] [--claude-dir DIR] [--agents-dir DIR] [--cursor-dir DIR] [--captain-name NAME] [--no-wake] [--share --share-relay URL | --no-share]';

// env and cwd are injectable for tests; the home falls back per lib/home.js detectHome.
function parseArgs(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const opts = {
    home: null,
    port: Number(env.SHIP_DECK_PORT) || DEFAULT_PORT,
    tmux: true,
    staleDays: env.SHIP_DECK_STALE_DAYS !== undefined ? Number(env.SHIP_DECK_STALE_DAYS) : DEFAULT_STALE_DAYS,
    ordersDir: env.SHIP_DECK_ORDERS_DIR || orders.defaultDir(),
    memoryDir: undefined, // derived from the home and claude dir below
    claudeDir: sessions.defaultClaudeDir(),
    captainName: env.SHIP_DECK_CAPTAIN || undefined, // undefined = git config user.name
    wake: true,
    open: !env.SHIP_DECK_NO_OPEN,
    share: !!env.SHIP_DECK_SHARE,
    shareRelay: env.SHIP_DECK_RELAY || null,
    agentsDir: null, // ~/.agents/skills and ~/.cursor/rules unless given (see below)
    cursorDir: null,
  };
  let homeFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split('=', 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--home') homeFlag = val();
    else if (flag === '--port') opts.port = Number(val());
    else if (flag === '--no-tmux') opts.tmux = false;
    else if (flag === '--stale-days') opts.staleDays = Number(val());
    else if (flag === '--orders-dir') opts.ordersDir = val();
    else if (flag === '--memory-dir') opts.memoryDir = val();
    else if (flag === '--claude-dir') opts.claudeDir = val();
    else if (flag === '--agents-dir') opts.agentsDir = val();
    else if (flag === '--cursor-dir') opts.cursorDir = val();
    else if (flag === '--captain-name') opts.captainName = val();
    else if (flag === '--no-wake') opts.wake = false;
    else if (flag === '--no-open') opts.open = false;
    else if (flag === '--share') opts.share = true;
    else if (flag === '--share-relay') opts.shareRelay = val();
    else if (flag === '--no-share') opts.share = false;
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error('unknown argument: ' + a);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    console.error('invalid --port');
    process.exit(2);
  }
  if (!Number.isFinite(opts.staleDays) || opts.staleDays <= 0) {
    console.error('invalid --stale-days (expected a positive number of days)');
    process.exit(2);
  }
  if (opts.share) {
    try { opts.shareRelay = share.checkRelayUrl(opts.shareRelay || ''); } catch (e) {
      console.error('--share needs --share-relay <https://relay> (or SHIP_DECK_RELAY): ' + e.message);
      process.exit(2);
    }
  }
  const found = homes.detectHome({ flag: homeFlag, env, cwd });
  opts.home = found.home;
  opts.homeSource = found.source;
  opts.homeChecked = found.checked;
  opts.ordersDir = path.resolve(opts.ordersDir);
  opts.claudeDir = path.resolve(opts.claudeDir);
  // Other agents that may get knowledge teammates share (lib/share.js KNOWLEDGE_TARGETS), detected
  // by their config folder. createServer itself writes to none unless given these.
  const user = os.homedir();
  opts.knowledgeTargets = [
    opts.agentsDir ? { id: 'agents', root: path.resolve(opts.agentsDir), detect: [path.dirname(path.resolve(opts.agentsDir))] }
      : { id: 'agents', root: path.join(user, '.agents', 'skills'), detect: [path.join(user, '.agents'), path.join(user, '.codex')] },
    opts.cursorDir ? { id: 'cursor', root: path.resolve(opts.cursorDir), detect: [path.dirname(path.resolve(opts.cursorDir))] }
      : { id: 'cursor', root: path.join(user, '.cursor', 'rules'), detect: [path.join(user, '.cursor')] },
  ];
  if (opts.memoryDir) opts.memoryDir = path.resolve(opts.memoryDir);
  else if (opts.memoryDir === undefined && opts.home) opts.memoryDir = homes.memoryDirFor(opts.claudeDir, opts.home);
  return opts;
}

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type, extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

// The page is only served as 127.0.0.1 or localhost on our own port. Checking
// Host blocks DNS rebinding; checking Origin (when the browser sends one) and
// requiring X-Ship-Deck on POST blocks cross-site form posts and fetches.
function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}
function hostOk(req) {
  return allowedHosts(req.socket.localPort).has(String(req.headers.host || '').toLowerCase());
}
// Raw uploads (POST /api/attachments) may not use the content types a plain HTML form can send.
const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;
function postGuard(req, { raw = false } = {}) {
  if (req.headers['x-ship-deck'] !== '1') return 'missing X-Ship-Deck header';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let o;
    try { o = new URL(origin); } catch { return 'bad origin'; }
    if (o.protocol !== 'http:' || !allowedHosts(req.socket.localPort).has(o.host.toLowerCase())) return 'cross-origin request refused';
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request refused';
  const type = String(req.headers['content-type'] || '');
  if (raw) return FORM_TYPES.test(type) ? 'form uploads refused; send the raw file' : null;
  if (!/^application\/json\b/i.test(type)) return 'expected application/json';
  return null;
}
function loopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; reject(new actions.ActionError(413, 'request body too large')); return; } // keep draining
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new actions.ActionError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Crew ids that have a state/<id>.meta and pass the strict action id check.
function knownIds(home) {
  let names = [];
  try { names = fs.readdirSync(path.join(home, 'state')); } catch { /* none */ }
  return new Set(names.filter((n) => n.endsWith('.meta')).map((n) => n.slice(0, -5)).filter(actions.validId));
}

// Ids, projects and backlog items an order may name, from a fresh read of the home.
async function orderContext(home) {
  const snap = await buildSnapshot(home, { tmux: false });
  const backlogIds = new Set();
  for (const k of ['captain', 'inFlight', 'queued', 'calls']) for (const b of snap.backlog[k] || []) if (b.id) backlogIds.add(b.id); // calls include questions from unknown sections
  return {
    knownIds: knownIds(home),
    doneIds: new Set(snap.tasks.filter((t) => t.state === 'done').map((t) => t.id)),
    projects: snap.projects.length ? new Set(snap.projects.map((p) => p.name)) : null,
    backlogIds,
  };
}

// The home path for display, with the user's home dir shortened to ~.
function tildePath(p) {
  const h = os.homedir();
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

// Session info for one crew member or the first mate, as the UI shows it (cwdLabel: the folder
// with the user's home as ~, for display; resume keeps the full path for copying).
function sessionView(entry, harness) {
  if (harness && harness !== 'claude') return { harness, sessionId: null, resume: null, note: `resume id unknown (${harness})` };
  if (!entry) return { harness: harness || 'claude', sessionId: null, resume: null, note: 'no Claude session found for this workspace yet' };
  return { harness: entry.harness || 'claude', sessionId: entry.sessionId, cwd: entry.cwd, cwdLabel: tildePath(entry.cwd), firstSeen: entry.firstSeen || null, lastSeen: entry.lastSeen || null, resume: sessions.resumeCommand(entry.cwd, entry.sessionId), note: null };
}

function serveStatic(url, res) {
  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return send(res, 400, 'bad path', 'text/plain'); }
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// First run, no firstmate home: /api/fleet says so (with the places checked) and the
// page explains how to point Ship Deck at a home. Nothing else is served from /api.
function firstRunServer(opts) {
  return http.createServer((req, res) => {
    if (!hostOk(req)) return send(res, 421, 'misdirected request', 'text/plain');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return json(res, 503, { ok: false, error: 'no firstmate home configured' }); }
    if (url.pathname === '/api/health') return json(res, 200, { app: 'ship-deck', ok: true, home: null });
    if (url.pathname === '/api/fleet') return json(res, 200, { firstRun: true, checked: opts.homeChecked || [] });
    if (url.pathname.startsWith('/api/')) return json(res, 503, { error: 'no firstmate home configured' });
    serveStatic(url, res);
  });
}

function createServer(opts) {
  const exec = opts.exec || actions.defaultExec;
  const ordersDir = opts.ordersDir || orders.defaultDir();
  const claudeDir = opts.claudeDir || sessions.defaultClaudeDir();
  const memoryDir = opts.memoryDir === undefined ? (opts.home ? homes.memoryDirFor(claudeDir, opts.home) : null) : opts.memoryDir;
  const captain = opts.captainName !== undefined ? (opts.captainName || null) : homes.captainName(opts.home);
  // No home found: serve the page (it shows the first-run screen) and refuse the fleet APIs.
  if (!opts.home) return firstRunServer(opts);
  const libOpts = { captainSkills: path.join(claudeDir, 'skills') };
  const tracker = sessions.createTracker({ home: opts.home, claudeDir, ordersDir });
  const feed = activity.createActivity({ home: opts.home, claudeDir });

  // The /api/fleet object (the share agent projects the same object).
  async function fleetSnapshot() {
    const snap = await buildSnapshot(opts.home, { tmux: opts.tmux, staleDays: opts.staleDays });
    const list = orders.listOrders(ordersDir);
    snap.orders = { dir: ordersDir, pending: list.filter((o) => o.pending).length, total: list.length, list: list.slice(0, ORDERS_IN_SNAPSHOT) };
    const replies = orders.readReplies(ordersDir);
    snap.thread = { sig: orders.threadSignature(ordersDir), replies: replies.length, lastReplyId: replies.length ? replies[replies.length - 1].id : null };
    const known = tracker.get(snap.tasks);
    for (const t of snap.tasks) {
      t.session = sessionView(known[t.id], t.harness);
      t.config = config.currentConfig(t, list);
    }
    snap.configOptions = config.options();
    snap.captain = { name: captain };
    snap.homeLabel = tildePath(opts.home);
    snap.firstmate = { session: sessionView(known[sessions.FIRST_MATE_KEY], 'claude') };
    return snap;
  }

  // Sharing (--share): readers hand the agent data; it never gets orders, wake or fm-send.
  // Skills a teammate shared with this captain are never passed on to anyone else.
  const isSkill = (e) => e.exists && e.key.startsWith('skill:') && !e.key.startsWith('skill:teammate:');
  const isNote = (e) => e.exists && (SHARE_NOTES.includes(e.key) || e.key.startsWith('memory:'));
  const readEntryText = (e) => { const r = library.readLibraryEntry(opts.home, memoryDir, e.key, libOpts); return (r && r.text) || ''; };
  const agent = opts.share ? share.createShareAgent({
    relayUrl: opts.shareRelay,
    dir: ordersDir,
    home: os.homedir(),
    fetchImpl: opts.shareFetch,
    now: opts.shareNow,
    log: (m) => console.warn(m),
    readFleet: fleetSnapshot,
    // Knowledge teammates share with this account lands here as teammate-* skills, and for the
    // other agents in opts.knowledgeTargets (parseArgs; none unless given).
    skillsDir: libOpts.captainSkills,
    targets: opts.knowledgeTargets || [],
    // Read only: how often this computer's agent used what teammates share (counts are reported).
    transcriptsDir: path.join(claudeDir, 'projects'),
    readTerminal: async (id) => (await actions.peekPane(opts.home, id, exec)).text,
    readExtras: async (needs) => {
      const fm = feed.view(NaN);
      const out = { firstMateWorking: !!fm.working };
      const lib = needs.skills || needs.notes ? library.listLibrary(opts.home, memoryDir, libOpts) : [];
      if (needs.skills) out.skills = lib.filter(isSkill).map((e) => ({ key: e.key, title: e.title, description: e.description }));
      if (needs.notes) out.notes = lib.filter(isNote).map((e) => ({ key: e.key, title: e.title, text: readEntryText(e) }));
      if (needs.chat) {
        out.thread = orders.buildThread(ordersDir, { limit: 30 });
        out.activity = fm.events;
      }
      return out;
    },
    // The knowledge library (grant scopes skills and notes): full text, only what a grant needs.
    readLibrary: async ({ skills, notes }) => library.listLibrary(opts.home, memoryDir, libOpts)
      .filter((e) => (skills && isSkill(e)) || (notes && isNote(e)))
      .map((e) => ({ key: e.key, title: e.title, description: e.description || '', text: readEntryText(e) })),
  }) : null;

  // Relay errors come back as plain messages; 401/4xx keep their status, the rest are 502.
  function shareError(res, e) {
    const status = e instanceof share.RelayError ? (e.status >= 400 && e.status < 500 ? e.status : 502) : 400;
    return json(res, status, { ok: false, error: e.message });
  }
  async function handleShareGet(req, res, url) {
    if (url.pathname === '/api/share') {
      if (!agent) return json(res, 200, { enabled: false });
      const snap = await buildSnapshot(opts.home, { tmux: false });
      const names = new Set(snap.projects.map((p) => p.name));
      for (const t of snap.tasks) if (t.project && t.project !== 'unassigned') names.add(t.project);
      return json(res, 200, { ...agent.status(), fleetProjects: [...names].sort((a, b) => a.localeCompare(b)) });
    }
    if (!agent) return json(res, 404, { error: 'sharing is off (start Ship Deck with --share)' });
    try {
      if (url.pathname === '/api/share/grants') return json(res, 200, { grants: await agent.listGrants() });
      if (url.pathname === '/api/share/usage') return json(res, 200, { rows: await agent.usageRows() });
      if (url.pathname === '/api/share/audit') return json(res, 200, { rows: await agent.audit(url.searchParams.get('since')) });
      if (url.pathname === '/api/share/preview') {
        const list = (k) => (url.searchParams.get(k) || '').split(',').filter(Boolean);
        const snapshot = await agent.preview({ scopes: list('scopes'), projects: list('projects') });
        return json(res, 200, { snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot)) });
      }
    } catch (e) { return shareError(res, e); }
    return json(res, 404, { error: 'not found' });
  }
  async function handleSharePost(req, res, url) {
    const why = postGuard(req);
    if (why) return json(res, 403, { ok: false, error: why });
    if (!agent) return json(res, 404, { ok: false, error: 'sharing is off (start Ship Deck with --share)' });
    const body = await readBody(req);
    try {
      if (url.pathname === '/api/share/signin') return json(res, 200, { ok: true, status: await agent.signIn({ email: body.email, password: body.password }) });
      if (url.pathname === '/api/share/signout') return json(res, 200, { ok: true, status: await agent.signOut() });
      if (url.pathname === '/api/share/grant') return json(res, 200, { ok: true, grants: await agent.putGrant(body) });
      if (url.pathname === '/api/share/revoke') return json(res, 200, { ok: true, grants: await agent.revoke(body.viewer) });
      if (url.pathname === '/api/share/invite') return json(res, 200, { ok: true, invite: await agent.invite(body.email) });
      if (url.pathname === '/api/share/pause') return json(res, 200, { ok: true, status: agent.setPaused(!!body.paused) });
      if (url.pathname === '/api/share/knowledge' && typeof body.reportUsage === 'boolean') return json(res, 200, { ok: true, status: agent.setReportUsage(body.reportUsage) });
      if (url.pathname === '/api/share/knowledge') return json(res, 200, { ok: true, status: agent.setKnowledge(!!body.on, typeof body.target === 'string' ? body.target : undefined) });
    } catch (e) { return shareError(res, e); }
  }

  // POST /api/attachments?name=<file name>: raw body, stored after a magic-byte check.
  // POST /api/attachments?parent=<id>&name=frame-0001.jpg|index.json: a video's extracted stills.
  async function handleUpload(req, res, url) {
    const why = !loopback(req) ? 'uploads only from 127.0.0.1' : postGuard(req, { raw: true });
    if (why) { req.resume(); return json(res, 403, { ok: false, error: why }); }
    const name = url.searchParams.get('name') || '';
    const parent = url.searchParams.get('parent');
    try {
      if (parent !== null) return json(res, 200, { ok: true, frame: await attachments.storeFrame(ordersDir, parent, name, req) });
      const declaredSize = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : undefined;
      const a = await attachments.storeStream(ordersDir, req, { name, declaredSize });
      return json(res, 200, { ok: true, attachment: { id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size } });
    } catch (e) {
      req.resume();
      if (e instanceof attachments.AttachmentError) return json(res, e.status, { ok: false, error: e.message });
      throw e;
    }
  }

  async function handlePost(req, res, url) {
    const why = postGuard(req);
    if (why) return json(res, 403, { ok: false, error: why });
    const body = await readBody(req);
    if (url.pathname === '/api/send') {
      const id = body.id;
      if (!actions.validId(id)) return json(res, 400, { ok: false, error: 'invalid id' });
      if (!knownIds(opts.home).has(id)) return json(res, 404, { ok: false, error: 'unknown worker' });
      const r = await actions.sendMessage(opts.home, id, body.message, exec);
      return json(res, r.ok ? 200 : 502, { ...r, error: r.ok ? null : r.output || `fm-send exited ${r.code}` });
    }
    if (url.pathname === '/api/config') {
      // { id, field, value }: claude workers get a live slash command via fm-send; others
      // (or a worker with no window) get a queued order the first mate applies on relaunch.
      const id = body.id;
      if (!actions.validId(id)) return json(res, 400, { ok: false, error: 'invalid id' });
      const known = knownIds(opts.home);
      if (!known.has(id)) return json(res, 404, { ok: false, error: 'unknown worker' });
      const harness = parseMeta(readText(path.join(opts.home, 'state', id + '.meta'))).harness || 'claude';
      let v;
      try { v = config.checkConfig(harness, body.field, body.value); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const live = config.canApplyLive(harness) && !!actions.lookupWindow(opts.home, id);
      let command = null;
      if (live) {
        command = config.slashCommand(harness, v.field, v.value);
        const r = await actions.sendMessage(opts.home, id, command, exec);
        if (!r.ok) return json(res, 502, { ok: false, command, error: r.output || `fm-send exited ${r.code}` });
      }
      const text = live ? `Set ${v.field} to ${v.value} (sent ${command}; applies from its next turn)` : `Set ${v.field} to ${v.value} on next relaunch`;
      const order = orders.createOrder(ordersDir, { kind: 'config', target: id, harness, field: v.field, value: v.value, applied: live, text }, { knownIds: known, internal: true });
      if (opts.wake !== false) wake.wake(opts.home, order);
      return json(res, 200, { ok: true, applied: live, command, order });
    }
    if (url.pathname === '/api/orders') {
      try {
        const order = orders.createOrder(ordersDir, body, await orderContext(opts.home));
        if (opts.wake !== false) wake.wake(opts.home, order);
        return json(res, 200, { ok: true, order });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req)) return send(res, 421, 'misdirected request', 'text/plain');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/api/attachments') return await handleUpload(req, res, url);
      if (req.method === 'POST' && POST_ROUTES.has(url.pathname)) return await handlePost(req, res, url);
      if (req.method === 'POST' && SHARE_POST.has(url.pathname)) return await handleSharePost(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
      if (url.pathname === '/api/health') return json(res, 200, { app: 'ship-deck', ok: true, home: opts.home });
      if (url.pathname === '/api/fleet') return json(res, 200, await fleetSnapshot());
      if (url.pathname === '/api/share' || url.pathname.startsWith('/api/share/')) return await handleShareGet(req, res, url);
      if (url.pathname === '/api/thread') {
        return json(res, 200, { sig: orders.threadSignature(ordersDir), items: orders.buildThread(ordersDir, { limit: THREAD_LIMIT }) });
      }
      if (url.pathname === '/api/activity') {
        // ?since=<rev>&epoch=<epoch> from the previous response: only changed events.
        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : NaN;
        return json(res, 200, feed.view(since, url.searchParams.get('epoch')));
      }
      if (url.pathname === '/api/sessions') {
        const present = knownIds(opts.home);
        const map = sessions.loadSessions(ordersDir);
        const entries = Object.entries(map).map(([id, e]) => ({
          id, firstmate: id === sessions.FIRST_MATE_KEY, present: id === sessions.FIRST_MATE_KEY || present.has(id), ...sessionView(e, e.harness),
        })).sort((a, b) => (b.firstmate - a.firstmate) || (b.present - a.present) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
        return json(res, 200, { entries });
      }
      const pm = /^\/api\/peek\/([^/]+)$/.exec(url.pathname);
      if (pm) {
        const id = decodeURIComponent(pm[1]);
        if (!knownIds(opts.home).has(id)) return json(res, 404, { error: 'unknown worker' });
        return json(res, 200, await actions.peekPane(opts.home, id, exec));
      }
      const am = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
      if (am) {
        try { return attachments.serve(ordersDir, decodeURIComponent(am[1]), req, res); } catch (e) {
          if (e instanceof attachments.AttachmentError) return json(res, e.status, { ok: false, error: e.message });
          throw e;
        }
      }
      const fm = /^\/api\/file\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (fm) return json(res, 200, actions.readDataFile(opts.home, decodeURIComponent(fm[1]), decodeURIComponent(fm[2])));
      if (url.pathname === '/api/library') {
        // sharing: false lets the library say how teammates' skills would arrive.
        return json(res, 200, { entries: library.listLibrary(opts.home, memoryDir, libOpts), sharing: !!agent });
      }
      if (url.pathname === '/api/library/file') {
        const r = library.readLibraryEntry(opts.home, memoryDir, url.searchParams.get('key'), libOpts);
        if (!r) return json(res, 404, { error: 'not in the library' });
        return json(res, 200, r);
      }
      const rm = /^\/api\/report\/([^/]+)$/.exec(url.pathname);
      if (rm) {
        const p = reportPath(opts.home, decodeURIComponent(rm[1]));
        const text = p && readText(p);
        if (text === null || text === undefined) return send(res, 404, 'no report', 'text/plain; charset=utf-8');
        return send(res, 200, text, 'text/plain; charset=utf-8');
      }
      serveStatic(url, res);
    } catch (e) {
      if (e instanceof actions.ActionError) return json(res, e.status, { ok: false, error: e.message });
      send(res, 500, String(e && e.message || e), 'text/plain');
    }
  });
  server.shareAgent = agent;
  return server;
}

// Listens on port, or the next free one (up to PORT_TRIES); resolves with the bound port.
function listen(server, port, { host = '127.0.0.1', tries = PORT_TRIES } = {}) {
  return new Promise((resolve, reject) => {
    let p = port;
    const attempt = () => {
      const onError = (e) => {
        server.removeListener('listening', onListening);
        if (e.code === 'EADDRINUSE' && p < port + tries - 1 && p < 65535) { p++; attempt(); } else reject(e);
      };
      const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    attempt();
  });
}

// Opens url in the default browser: fixed argv, our own URL, startup only.
function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { execFile(cmd, args, { timeout: 10000 }, () => { /* no browser: the URL is printed */ }).unref(); } catch { /* ignore */ }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.home) {
    console.warn('No firstmate home found (checked --home, FM_HOME, ' + opts.homeChecked.join(', ') + ').');
    console.warn('The page explains how to point Ship Deck at one: ship-deck --home /path/to/firstmate');
  } else if (!fs.existsSync(path.join(opts.home, 'state'))) {
    console.warn(`warning: ${opts.home}/state not found; the deck will be empty`);
  }
  let port;
  let server;
  try {
    server = createServer(opts);
    port = await listen(server, opts.port);
  } catch (e) {
    console.error(`Ship Deck could not listen on 127.0.0.1:${opts.port}-${opts.port + PORT_TRIES - 1}: ${e.message}`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}/`;
  if (opts.home) {
    console.log(`Ship Deck reading ${opts.home} (${opts.homeSource === 'flag' ? '--home' : opts.homeSource === 'env' ? 'FM_HOME' : 'auto-detected'}; read-only, quiet after ${opts.staleDays} d)`);
    console.log(`  messages: ${opts.ordersDir}   library memory: ${opts.memoryDir || '(none)'}   claude: ${opts.claudeDir}`);
  }
  if (port !== opts.port) console.log(`  port ${opts.port} is taken; using ${port}`);
  if (server.shareAgent) {
    server.shareAgent.start();
    console.log(`  sharing: on (relay ${opts.shareRelay}); manage it at ${'http://127.0.0.1:' + port}/share.html`);
  }
  console.log(`Ship Deck: ${url}`);
  if (opts.open) openBrowser(url);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { createServer, parseArgs, postGuard, knownIds, orderContext, listen, main, DEFAULT_PORT };
