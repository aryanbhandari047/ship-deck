'use strict';
// Captain's orders to the first mate: an append-only queue in ~/.ship-deck/,
// outside FM_HOME. Ship Deck only records orders; the first mate reads them
// (bin/orders.js, bin/orders-check.sh) and acknowledges them in a second log.
//
//   orders.jsonl      {id, ts, kind, target, text, status:"pending"}  (written by Ship Deck)
//   orders-ack.jsonl  {id, ts, status, note}                         (written by the first mate)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ORDERS_FILE = 'orders.jsonl';
const ACKS_FILE = 'orders-ack.jsonl';
const ACK_STATUSES = ['acknowledged', 'done', 'declined'];
// kind -> default text, and whether it is aimed at one crew member.
const ORDER_KINDS = {
  cleanup: { needsTarget: true, text: 'Clean up this worker' },
  merge: { needsTarget: true, text: 'Merge its PR' },
  answer: { needsTarget: true, text: null }, // free text required
  status: { needsTarget: true, text: 'Ask for status' },
  order: { needsTarget: false, text: null }, // free text required
};
const MAX_TEXT = 2000;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ORDER_ID_RE = /^o-\d{8}T\d{9}Z-[0-9a-f]{4}$/;

// ~/.ship-deck, or $SHIP_DECK_ORDERS_DIR (shared with bin/orders.js and bin/orders-check.sh).
function defaultDir() {
  return process.env.SHIP_DECK_ORDERS_DIR || path.join(os.homedir(), '.ship-deck');
}

// Creates the orders dir (0700) and returns it.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function appendLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// One line of plain text: control characters and newlines collapse to spaces.
function cleanText(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Time-sortable id, strictly increasing within this process, so orders-check.sh
// can count "ids greater than the cursor" with a plain string compare.
let lastMs = 0;
function newOrderId(now = Date.now()) {
  const ms = Math.max(now, lastMs + 1);
  lastMs = ms;
  const iso = new Date(ms).toISOString(); // 2026-10-12T16:00:00.123Z
  const stamp = iso.slice(0, 10).replace(/-/g, '') + 'T' + iso.slice(11, 23).replace(/[:.]/g, '') + 'Z';
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `o-${stamp}-${rand}`;
}

// Parses a JSON-lines log, skipping blank and malformed lines.
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && typeof o.id === 'string') out.push(o);
    } catch { /* skip junk */ }
  }
  return out;
}

// Validates and normalises an order request. Throws Error with a user-facing message.
// knownIds: optional Set of crew ids; a target must be one of them.
function validateOrder({ kind, target, text } = {}, knownIds = null) {
  const spec = ORDER_KINDS[kind];
  if (!spec) throw new Error('unknown order kind');
  const body = cleanText(text);
  if (body.length > MAX_TEXT) throw new Error(`text is longer than ${MAX_TEXT} characters`);
  let tgt = null;
  if (spec.needsTarget) {
    if (!TASK_ID_RE.test(String(target || ''))) throw new Error('invalid target id');
    if (knownIds && !knownIds.has(target)) throw new Error('unknown target id');
    tgt = target;
  } else if (target !== undefined && target !== null && target !== '') {
    if (!TASK_ID_RE.test(String(target))) throw new Error('invalid target id');
    if (knownIds && !knownIds.has(target)) throw new Error('unknown target id');
    tgt = target;
  }
  const finalText = body || spec.text;
  if (!finalText) throw new Error('text is required');
  return { kind, target: tgt, text: finalText };
}

function createOrder(dir, req, opts = {}) {
  const v = validateOrder(req, opts.knownIds);
  const now = opts.now || Date.now();
  const order = { id: newOrderId(now), ts: new Date(now).toISOString(), kind: v.kind, target: v.target, text: v.text, status: 'pending' };
  appendLine(path.join(dir, ORDERS_FILE), order);
  return order;
}

function readOrders(dir) {
  return readJsonl(path.join(dir, ORDERS_FILE));
}
function readAcks(dir) {
  return readJsonl(path.join(dir, ACKS_FILE)).filter((a) => ACK_STATUSES.includes(a.status));
}

// Each order with its latest ack applied. Pending = no ack yet. Newest first.
function mergeOrders(orders, acks) {
  const latest = new Map();
  for (const a of acks) latest.set(a.id, a); // later lines win
  return orders.map((o) => {
    const a = latest.get(o.id);
    return {
      id: o.id, ts: o.ts || null, kind: o.kind || 'order', target: o.target || null, text: o.text || '',
      status: a ? a.status : 'pending',
      pending: !a,
      note: a && a.note ? String(a.note) : null,
      ackTs: a ? a.ts || null : null,
    };
  }).reverse();
}

function listOrders(dir, { pendingOnly = false, limit = 0 } = {}) {
  let list = mergeOrders(readOrders(dir), readAcks(dir));
  if (pendingOnly) list = list.filter((o) => o.pending);
  return limit > 0 ? list.slice(0, limit) : list;
}

function ackOrder(dir, id, status, note, opts = {}) {
  if (!ACK_STATUSES.includes(status)) throw new Error(`status must be one of: ${ACK_STATUSES.join(', ')}`);
  if (!readOrders(dir).some((o) => o.id === id)) throw new Error(`no such order: ${id}`);
  const ack = { id, ts: new Date(opts.now || Date.now()).toISOString(), status, note: cleanText(note).slice(0, MAX_TEXT) };
  appendLine(path.join(dir, ACKS_FILE), ack);
  return ack;
}

module.exports = {
  ORDERS_FILE,
  ACKS_FILE,
  ACK_STATUSES,
  ORDER_KINDS,
  MAX_TEXT,
  TASK_ID_RE,
  ORDER_ID_RE,
  defaultDir,
  cleanText,
  newOrderId,
  validateOrder,
  createOrder,
  readOrders,
  readAcks,
  mergeOrders,
  listOrders,
  ackOrder,
};
