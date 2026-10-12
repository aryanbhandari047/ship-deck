#!/usr/bin/env node
'use strict';
// Ship Deck: a read-only live view of a firstmate fleet.
//   node server.js [--home <FM_HOME>] [--port 4747] [--stale-days 7] [--no-tmux]
// Binds to 127.0.0.1 only. Never writes to FM_HOME.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildSnapshot, reportPath, readText, DEFAULT_STALE_DAYS } = require('./lib/fleet');

const DEFAULT_HOME = '/Users/aryanbhandari/Desktop/AI/firstmate';

function parseArgs(argv) {
  const opts = {
    home: process.env.FM_HOME || DEFAULT_HOME,
    port: Number(process.env.SHIP_DECK_PORT) || 4747,
    tmux: true,
    staleDays: process.env.SHIP_DECK_STALE_DAYS !== undefined ? Number(process.env.SHIP_DECK_STALE_DAYS) : DEFAULT_STALE_DAYS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.split('=', 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--home') opts.home = val();
    else if (flag === '--port') opts.port = Number(val());
    else if (flag === '--no-tmux') opts.tmux = false;
    else if (flag === '--stale-days') opts.staleDays = Number(val());
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node server.js [--home FM_HOME] [--port 4747] [--stale-days 7] [--no-tmux]');
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

function createServer(opts) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/fleet') {
        const snap = await buildSnapshot(opts.home, { tmux: opts.tmux, staleDays: opts.staleDays });
        return send(res, 200, JSON.stringify(snap), 'application/json; charset=utf-8');
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
    console.log(`  http://127.0.0.1:${opts.port}/`);
  });
}

module.exports = { createServer, parseArgs };
