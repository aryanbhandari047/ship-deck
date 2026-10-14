'use strict';
// Tiny request/response helpers for Node's http objects (Vercel Node functions and relay/dev.js).

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendText(res, status, text, type, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type + '; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

// The JSON body, at most max bytes. Bodies are never logged.
function readJson(req, max) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); reject(new HttpError(415, 'expected application/json')); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return reject(new HttpError(413, 'request body too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', () => reject(new HttpError(400, 'bad request')));
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f.slice(0, 64);
  }
  return String((req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

// Cookie-authenticated POSTs must come from the relay's own pages (login CSRF, logout CSRF).
function sameOrigin(req, baseUrl) {
  const origin = req.headers.origin;
  if (origin !== undefined) return origin === baseUrl;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin';
}

function bearer(req) {
  const m = /^Bearer\s+(\S{10,2048})$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

module.exports = { HttpError, BASE_HEADERS, sendJson, sendText, readJson, clientIp, sameOrigin, bearer };
