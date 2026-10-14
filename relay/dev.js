#!/usr/bin/env node
'use strict';
// Local relay for development and tests: static pages from public/ plus the same handler Vercel
// runs, on an in-memory store (or Upstash when its env vars are set).
//   node dev.js [--port 3000] [--invite you@keychain.com]
// --invite prints a one-time invite link (the local equivalent of scripts/bootstrap-owner.js).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, configProblems } = require('./lib/config');
const { createMemoryStore, createUpstashStore } = require('./lib/store');
const { createRelay } = require('./lib/app');
const { createPasswordAuth } = require('./auth/password');
const { BASE_HEADERS } = require('./lib/http');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Mirrors vercel.json: cleanUrls (/invite -> invite.html) and the security headers.
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '') + (path.extname(pathname) ? '' : '.html');
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return false;
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
  res.end(fs.readFileSync(file));
  return true;
}

function createDevServer({ config, store, now, log } = {}) {
  config = config || loadConfig();
  store = store || (config.upstash.url ? createUpstashStore(config.upstash) : createMemoryStore({ now }));
  const handle = createRelay({ config, store, now, log });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/') && serveStatic(url.pathname, res)) return;
    handle(req, res);
  });
  return { server, store, config };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(arg('--port') || process.env.PORT || 3000);
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
    console.warn('SESSION_SECRET not set: using a random one (deck tokens stop working on restart)');
  }
  if (!process.env.PUBLIC_BASE_URL) process.env.PUBLIC_BASE_URL = `http://localhost:${port}`;
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length) { console.error(problems.join('\n')); process.exit(2); }
  const { server, store } = createDevServer({ config });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  console.log(`Ship Deck relay (dev, ${store.kind} store): ${config.baseUrl}`);
  const email = arg('--invite');
  if (email) {
    const inv = await createPasswordAuth({ store, config }).createInvite({ email });
    console.log(`Invite for ${inv.email} (24 h, single use): ${inv.link}`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { createDevServer, serveStatic };
