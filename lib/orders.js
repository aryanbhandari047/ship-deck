'use strict';
// Captain's orders to the first mate: an append-only queue in ~/.ship-deck/,
// outside FM_HOME. Ship Deck only records orders; the first mate reads them
// (bin/orders.js, bin/orders-check.sh) and acknowledges them in a second log.
//
//   orders.jsonl      {id, ts, kind, target, text, status:"pending", ...payload}  (written by Ship Deck)
//   orders-ack.jsonl  {id, ts, status, note}                                    (written by the first mate)
//   replies.jsonl     {id, ts, kind:"reply", inReplyTo, text[, attachments]}    (written by the first mate)
// Chat orders and replies may carry attachments [{id, kind, name, path, size, ...}] (lib/attachments.js).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const attachments = require('./attachments');
const settings = require('./settings');

const ORDERS_FILE = 'orders.jsonl';
const ACKS_FILE = 'orders-ack.jsonl';
const REPLIES_FILE = 'replies.jsonl';
const ACK_STATUSES = ['acknowledged', 'done', 'declined'];
// kind -> default text, whether it names one crew member, whether text keeps
// newlines, and whether it is irreversible (the UI warns before queueing).
const ORDER_KINDS = {
  chat: { needsTarget: false, text: null, multiline: true },
  cleanup: { needsTarget: true, text: 'Clean up this worker', irreversible: true },
  merge: { needsTarget: true, text: 'Merge its PR', irreversible: true },
  answer: { needsTarget: true, text: null, multiline: true },
  decision: { needsTarget: true, text: null, multiline: true },
  status: { needsTarget: true, text: 'Ask for status' },
  'new-task': { needsTarget: false, text: null, multiline: true },
  'cleanup-done': { needsTarget: false, text: 'Clean up all finished workers', irreversible: true },
  'backlog-start': { needsTarget: false, text: 'Start this queue item', multiline: true },
  'backlog-answer': { needsTarget: false, text: null, multiline: true },
  order: { needsTarget: false, text: null },
  config: { needsTarget: true, text: null, internal: true }, // only via POST /api/config
  address: { needsTarget: false, text: null, internal: true }, // only via POST /api/settings
};
const MAX_TEXT = 2000;
const MAX_CHAT = 4000;
const MAX_REPLY = 64 * 1024;
const MAX_TARGETS = 200;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ORDER_ID_RE = /^o-\d{8}T\d{9}Z-[0-9a-f]{4}$/;
const REPLY_ID_RE = /^r-\d{8}T\d{9}Z-[0-9a-f]{4}$/;
const ITEM_ID_RE = /^[A-Za-z0-9][\w.-]{0,127}$/;
const PROJECT_RE = /^[\w.-]{1,100}$/;
const TASK_KINDS = ['scout', 'ship'];

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

// Markdown-friendly text: keeps newlines and tabs, drops other control characters.
function cleanMultiline(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// Time-sortable id, strictly increasing within this process, so orders-check.sh
// can count "ids greater than the cursor" with a plain string compare.
let lastMs = 0;
function newOrderId(now = Date.now(), prefix = 'o') {
  const ms = Math.max(now, lastMs + 1);
  lastMs = ms;
  const iso = new Date(ms).toISOString(); // 2026-10-12T16:00:00.123Z
  const stamp = iso.slice(0, 10).replace(/-/g, '') + 'T' + iso.slice(11, 23).replace(/[:.]/g, '') + 'Z';
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${prefix}-${stamp}-${rand}`;
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
// ctx: a Set of known crew ids (legacy) or { knownIds, doneIds, projects, backlogIds },
// each an optional Set the matching field must belong to.
function validateOrder(req = {}, ctx = null) {
  const { kind, target, text } = req || {};
  const c = ctx instanceof Set ? { knownIds: ctx } : ctx || {};
  const spec = Object.prototype.hasOwnProperty.call(ORDER_KINDS, kind) ? ORDER_KINDS[kind] : null;
  if (!spec || (spec.internal && !c.internal)) throw new Error('unknown order kind');
  const checkId = (id, set = c.knownIds) => {
    if (typeof id !== 'string' || id.length > 128 || !TASK_ID_RE.test(id)) throw new Error('invalid target id');
    if (set && !set.has(id)) throw new Error('unknown target id');
    return id;
  };
  const body = spec.multiline ? cleanMultiline(text) : cleanText(text);
  const max = kind === 'chat' ? MAX_CHAT : MAX_TEXT;
  if (body.length > max) throw new Error(`text is longer than ${max} characters`);
  let tgt = null;
  if (spec.needsTarget) tgt = checkId(target);
  else if (target !== undefined && target !== null && target !== '') tgt = checkId(target);
  const out = { kind, target: tgt };
  if (kind === 'decision' || kind === 'backlog-answer') {
    const opt = req.option === undefined || req.option === null || req.option === '' ? null : String(req.option).toUpperCase();
    if (opt !== null && !/^[A-H]$/.test(opt)) throw new Error('option must be a letter A-H');
    if (!opt && !body) throw new Error('pick an option or write an answer');
    out.option = opt;
    // Set only by server.js after it checked a pending viewer suggestion (live pairing); never
    // from the request. The viewer's note is never part of the order.
    if (kind === 'decision' && typeof c.suggestedBy === 'string' && c.suggestedBy) out.suggestedBy = c.suggestedBy.slice(0, 254);
  }
  if (kind === 'backlog-start' || kind === 'backlog-answer') {
    if (typeof req.item !== 'string' || !ITEM_ID_RE.test(req.item)) throw new Error('invalid queue item');
    if (c.backlogIds && !c.backlogIds.has(req.item)) throw new Error('unknown queue item');
    out.item = req.item;
  }
  if (kind === 'new-task') {
    if (typeof req.project !== 'string' || !PROJECT_RE.test(req.project)) throw new Error('invalid project');
    if (c.projects && !c.projects.has(req.project)) throw new Error('unknown project');
    if (!TASK_KINDS.includes(req.taskKind)) throw new Error(`taskKind must be one of: ${TASK_KINDS.join(', ')}`);
    out.project = req.project;
    out.taskKind = req.taskKind;
    Object.assign(out, config.checkJobConfig(req));
  }
  if (kind === 'config') {
    const v = config.checkConfig(req.harness, req.field, req.value);
    Object.assign(out, { field: v.field, value: v.value, applied: req.applied === true });
  }
  if (kind === 'address') out.address = settings.cleanAddress(req.address);
  if (kind === 'cleanup-done') {
    if (!Array.isArray(req.targets) || !req.targets.length) throw new Error('no finished workers to clean up');
    if (req.targets.length > MAX_TARGETS) throw new Error('too many targets');
    const ids = [...new Set(req.targets.map((id) => checkId(id)))];
    if (c.doneIds) for (const id of ids) if (!c.doneIds.has(id)) throw new Error(`${id} is not done`);
    out.targets = ids;
  }
  const hasAttachments = Array.isArray(req.attachments) && req.attachments.length > 0;
  if (hasAttachments && kind !== 'chat') throw new Error('only chat messages take attachments');
  out.text = body || spec.text || (out.option ? `Option ${out.option}` : null);
  if (!out.text && hasAttachments) out.text = ''; // a chat message may be attachments only
  else if (!out.text) throw new Error('text is required');
  return out;
}

function createOrder(dir, req, opts = {}) {
  const v = validateOrder(req, opts);
  const now = opts.now || Date.now();
  const { kind, target, text, ...payload } = v;
  if (kind === 'chat' && req.attachments && req.attachments.length) payload.attachments = attachments.resolveIds(dir, req.attachments).map(record);
  const order = { id: newOrderId(now), ts: new Date(now).toISOString(), kind, target, text, status: 'pending', ...payload };
  appendLine(path.join(dir, ORDERS_FILE), order);
  return order;
}

// The attachment fields recorded on an order or reply line.
function record(a) {
  const r = { id: a.id, kind: a.kind, name: a.name, path: a.path, size: a.size, mime: a.mime };
  if (a.kind === 'video') Object.assign(r, { frames: a.frames || null, frameCount: a.frameCount || 0 });
  return r;
}
// Attachment records from a log line, keeping only well-formed entries.
function cleanAttachments(list) {
  if (!Array.isArray(list)) return null;
  const out = list.filter((a) => a && attachments.validId(a.id) && (a.kind === 'image' || a.kind === 'video') && typeof a.path === 'string');
  return out.length ? out : null;
}

function readOrders(dir) {
  return readJsonl(path.join(dir, ORDERS_FILE));
}
function readAcks(dir) {
  return readJsonl(path.join(dir, ACKS_FILE)).filter((a) => ACK_STATUSES.includes(a.status));
}

const PAYLOAD_KEYS = ['option', 'item', 'project', 'taskKind', 'harness', 'model', 'effort', 'targets', 'field', 'value', 'applied', 'address'];

// Each order with its latest ack applied and its ack history. Pending = no ack yet. Newest first.
function mergeOrders(orders, acks) {
  const history = new Map();
  for (const a of acks) {
    if (!history.has(a.id)) history.set(a.id, []);
    history.get(a.id).push({ status: a.status, ts: a.ts || null, note: a.note ? String(a.note) : null });
  }
  return orders.map((o) => {
    const h = history.get(o.id) || [];
    const a = h[h.length - 1]; // later lines win
    const out = {
      id: o.id, ts: o.ts || null, kind: o.kind || 'order', target: o.target || null, text: String(o.text || ''),
      status: a ? a.status : 'pending',
      pending: !a,
      note: a && a.note ? a.note : null,
      ackTs: a ? a.ts : null,
      history: h,
    };
    for (const k of PAYLOAD_KEYS) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
    const att = cleanAttachments(o.attachments);
    if (att) out.attachments = att;
    return out;
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

// ---------- first mate replies ----------

function readReplies(dir) {
  return readJsonl(path.join(dir, REPLIES_FILE))
    .filter((r) => typeof r.text === 'string')
    .map((r) => {
      const out = { id: r.id, ts: r.ts || null, kind: 'reply', inReplyTo: typeof r.inReplyTo === 'string' ? r.inReplyTo : null, text: r.text };
      const att = cleanAttachments(r.attachments);
      if (att) out.attachments = att;
      return out;
    });
}

// inReplyTo: an order id, or null / '-' for an unprompted message from the first mate.
// opts.attach: local file paths copied into the attachments dir (checked before anything is written).
function createReply(dir, inReplyTo, text, opts = {}) {
  const to = inReplyTo === '-' || inReplyTo === undefined || inReplyTo === null || inReplyTo === '' ? null : String(inReplyTo);
  if (to !== null && !readOrders(dir).some((o) => o.id === to)) throw new Error(`no such order: ${to}`);
  const files = opts.attach || [];
  if (files.length > attachments.MAX_PER_MESSAGE) throw new Error(`at most ${attachments.MAX_PER_MESSAGE} attachments per reply`);
  const body = cleanMultiline(text);
  if (!body && !files.length) throw new Error('reply text is empty');
  if (Buffer.byteLength(body) > MAX_REPLY) throw new Error(`reply is larger than ${MAX_REPLY / 1024} KB`);
  for (const f of files) attachments.checkFile(f);
  const now = opts.now || Date.now();
  const reply = { id: newOrderId(now, 'r'), ts: new Date(now).toISOString(), kind: 'reply', inReplyTo: to, text: body };
  if (files.length) reply.attachments = files.map((f) => record(attachments.importFile(dir, f)));
  appendLine(path.join(dir, REPLIES_FILE), reply);
  return reply;
}

// Orders (with acks) and replies as one conversation, oldest first.
function buildThread(dir, { limit = 0 } = {}) {
  const items = [
    ...mergeOrders(readOrders(dir), readAcks(dir)).map((o) => ({ type: 'order', ...o })),
    ...readReplies(dir).map((r) => ({ type: 'reply', ...r })),
  ];
  const key = (x) => `${x.ts || ''}|${x.id.slice(2)}`;
  items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return limit > 0 ? items.slice(-limit) : items;
}

// Cheap change marker for the thread: sizes and mtimes of the three logs.
function threadSignature(dir) {
  return [ORDERS_FILE, ACKS_FILE, REPLIES_FILE].map((f) => {
    try { const st = fs.statSync(path.join(dir, f)); return `${st.size}.${Math.round(st.mtimeMs)}`; } catch { return '0'; }
  }).join('-');
}

module.exports = {
  ORDERS_FILE,
  ACKS_FILE,
  REPLIES_FILE,
  ACK_STATUSES,
  ORDER_KINDS,
  TASK_KINDS,
  MAX_TEXT,
  MAX_CHAT,
  MAX_REPLY,
  TASK_ID_RE,
  ORDER_ID_RE,
  REPLY_ID_RE,
  defaultDir,
  ensureDir,
  appendLine,
  readJsonl,
  cleanText,
  cleanMultiline,
  readReplies,
  createReply,
  buildThread,
  threadSignature,
  newOrderId,
  validateOrder,
  createOrder,
  readOrders,
  readAcks,
  mergeOrders,
  listOrders,
  ackOrder,
};
