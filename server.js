#!/usr/bin/env node
'use strict';
// Ship Deck: a live view of a firstmate fleet with a few captain's actions.
//   node server.js [--home <FM_HOME>] [--port 4747] [--stale-days 7] [--no-tmux]
//                  [--orders-dir ~/.ship-deck] [--memory-dir <dir>]
// Binds to 127.0.0.1 only. Never writes to FM_HOME; the only file writes go to
// the orders dir (~/.ship-deck). The only commands run are tmux list-windows,
// tmux capture-pane and <home>/bin/fm-send.sh (see lib/actions.js).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildSnapshot, reportPath, readText, DEFAULT_STALE_DAYS } = require('./lib/fleet');
const orders = require('./lib/orders');
const actions = require('./lib/actions');
const library = require('./lib/library');

const DEFAULT_HOME = '/Users/aryanbhandari/Desktop/AI/firstmate';
const MAX_BODY = 16 * 1024;
const ORDERS_IN_SNAPSHOT = 60;
const POST_ROUTES = new Set(['/api/send', '/api/orders']);

function parseArgs(argv) {
  const opts = {
    home: process.env.FM_HOME || DEFAULT_HOME,
    port: Number(process.env.SHIP_DECK_PORT) || 4747,
    tmux: true,
    staleDays: process.env.SHIP_DECK_STALE_DAYS !== undefined ? Number(process.env.SHIP_DECK_STALE_DAYS) : DEFAULT_STALE_DAYS,
    ordersDir: orders.defaultDir(),
    memoryDir: library.DEFAULT_MEMORY_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split('=', 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--home') opts.home = val();
    else if (flag === '--port') opts.port = Number(val());
    else if (flag === '--no-tmux') opts.tmux = false;
    else if (flag === '--stale-days') opts.staleDays = Number(val());
    else if (flag === '--orders-dir') opts.ordersDir = val();
    else if (flag === '--memory-dir') opts.memoryDir = val();
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node server.js [--home FM_HOME] [--port 4747] [--stale-days 7] [--no-tmux] [--orders-dir DIR] [--memory-dir DIR]');
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
  opts.home = path.resolve(opts.home);
  opts.ordersDir = path.resolve(opts.ordersDir);
  if (opts.memoryDir) opts.memoryDir = path.resolve(opts.memoryDir);
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
function postGuard(req) {
  if (req.headers['x-ship-deck'] !== '1') return 'missing X-Ship-Deck header';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let o;
    try { o = new URL(origin); } catch { return 'bad origin'; }
    if (o.protocol !== 'http:' || !allowedHosts(req.socket.localPort).has(o.host.toLowerCase())) return 'cross-origin request refused';
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request refused';
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return 'expected application/json';
  return null;
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

function createServer(opts) {
  const exec = opts.exec || actions.defaultExec;
  const ordersDir = opts.ordersDir || orders.defaultDir();
  const memoryDir = opts.memoryDir === undefined ? library.DEFAULT_MEMORY_DIR : opts.memoryDir;

  async function handlePost(req, res, url) {
    const why = postGuard(req);
    if (why) return json(res, 403, { ok: false, error: why });
    const body = await readBody(req);
    if (url.pathname === '/api/send') {
      const id = body.id;
      if (!actions.validId(id)) return json(res, 400, { ok: false, error: 'invalid id' });
      if (!knownIds(opts.home).has(id)) return json(res, 404, { ok: false, error: 'unknown crew id' });
      const r = await actions.sendMessage(opts.home, id, body.message, exec);
      return json(res, r.ok ? 200 : 502, { ...r, error: r.ok ? null : r.output || `fm-send exited ${r.code}` });
    }
    if (url.pathname === '/api/orders') {
      try {
        const order = orders.createOrder(ordersDir, body, { knownIds: knownIds(opts.home) });
        return json(res, 200, { ok: true, order });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
  }

  return http.createServer(async (req, res) => {
    if (!hostOk(req)) return send(res, 421, 'misdirected request', 'text/plain');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && POST_ROUTES.has(url.pathname)) return await handlePost(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
      if (url.pathname === '/api/fleet') {
        const snap = await buildSnapshot(opts.home, { tmux: opts.tmux, staleDays: opts.staleDays });
        const list = orders.listOrders(ordersDir);
        snap.orders = { dir: ordersDir, pending: list.filter((o) => o.pending).length, total: list.length, list: list.slice(0, ORDERS_IN_SNAPSHOT) };
        return json(res, 200, snap);
      }
      const pm = /^\/api\/peek\/([^/]+)$/.exec(url.pathname);
      if (pm) {
        const id = decodeURIComponent(pm[1]);
        if (!knownIds(opts.home).has(id)) return json(res, 404, { error: 'unknown crew id' });
        return json(res, 200, await actions.peekPane(opts.home, id, exec));
      }
      const fm = /^\/api\/file\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (fm) return json(res, 200, actions.readDataFile(opts.home, decodeURIComponent(fm[1]), decodeURIComponent(fm[2])));
      if (url.pathname === '/api/library') {
        return json(res, 200, { entries: library.listLibrary(opts.home, memoryDir) });
      }
      if (url.pathname === '/api/library/file') {
        const r = library.readLibraryEntry(opts.home, memoryDir, url.searchParams.get('key'));
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
      let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
      fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, 'not found', 'text/plain');
        send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
      });
    } catch (e) {
      if (e instanceof actions.ActionError) return json(res, e.status, { ok: false, error: e.message });
      send(res, 500, String(e && e.message || e), 'text/plain');
    }
  });
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts.home, 'state'))) {
    console.warn(`warning: ${opts.home}/state not found; the deck will be empty`);
  }
  createServer(opts).listen(opts.port, '127.0.0.1', () => {
    console.log(`Ship Deck reading ${opts.home} (read-only, stale after ${opts.staleDays} d)`);
    console.log(`  orders: ${opts.ordersDir}   library memory: ${opts.memoryDir || '(none)'}`);
    console.log(`  http://127.0.0.1:${opts.port}/`);
  });
}

module.exports = { createServer, parseArgs, postGuard, knownIds };
