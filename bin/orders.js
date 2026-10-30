#!/usr/bin/env node
'use strict';
// Captain's orders queue and Bridge chat, for the first mate.
//   node bin/orders.js list [--pending] [--json]
//   node bin/orders.js ack <id> <acknowledged|done|declined> [note...]
//   node bin/orders.js reply <order-id|-> [--ack <status>] [--file <path|->] [--attach <path>]... [text...]
//   node bin/orders.js thread [--json] [--limit N]
//   node bin/orders.js sessions [--json]
// Reads/writes ~/.ship-deck/ (SHIP_DECK_ORDERS_DIR overrides the directory).

const fs = require('node:fs');
const orders = require('../lib/orders');
const sessions = require('../lib/sessions');
const attachments = require('../lib/attachments');
const settings = require('../lib/settings');

const USAGE = [
  'usage: node bin/orders.js list [--pending] [--json]',
  '       node bin/orders.js ack <id> <' + orders.ACK_STATUSES.join('|') + '> [note...]',
  '       node bin/orders.js reply <order-id|-> [--ack <status>] [--file <path|->] [--attach <path>]... [text...]',
  '       node bin/orders.js thread [--json] [--limit N]',
  '       node bin/orders.js sessions [--json]',
].join('\n');

const indent = (s, pad = '    ') => String(s).split('\n').map((l) => pad + l).join('\n');

function payloadLine(o) {
  const parts = [];
  if (o.option) parts.push(`option=${o.option}`);
  if (o.item) parts.push(`item=${o.item}`);
  if (o.project) parts.push(`project=${o.project}`);
  if (o.taskKind) parts.push(`taskKind=${o.taskKind}`);
  for (const k of ['harness', 'model', 'effort', 'field', 'value']) if (o[k]) parts.push(`${k}=${o[k]}`);
  if (o.address !== undefined) parts.push(`address=${JSON.stringify(o.address)}`);
  if (o.applied !== undefined) parts.push(`applied=${o.applied}`);
  if (o.targets) parts.push(`targets=${o.targets.join(',')}`);
  return parts.join(' ');
}

// One line per attachment (absolute path to open), plus the frames dir of a video.
function attachmentLines(o) {
  const lines = [];
  for (const a of o.attachments || []) {
    lines.push(`    attachment: ${a.kind} ${a.name} (${attachments.humanSize(a.size || 0)}) ${a.path}`);
    if (a.kind === 'video') {
      lines.push(a.frames
        ? `      frames: ${a.frames} (${a.frameCount} stills, index.json has timestamps)`
        : '      frames: none extracted (watch the video in Ship Deck)');
    }
  }
  return lines;
}

// The captain's form of address from Ship Deck's settings, as a reminder on top of list and
// thread (only when it differs from "Captain", the firstmate default).
function addressLine(dir) {
  const { address } = settings.readSettings(dir);
  if (address === settings.DEFAULT_ADDRESS) return null;
  return address
    ? `address the captain as: "${address}" (their Ship Deck setting)`
    : 'address the captain as: no title or name, just talk to them directly (their Ship Deck setting)';
}

function main(argv, dir = orders.defaultDir(), out = console.log, err = console.error, readFile = (p) => fs.readFileSync(p === '-' ? 0 : p, 'utf8')) {
  const [cmd, ...rest] = argv;
  const remind = () => { const l = addressLine(dir); if (l) out(l); };
  if (cmd === 'list') {
    const bad = rest.filter((a) => a !== '--pending' && a !== '--json');
    if (bad.length) { err(USAGE); return 2; }
    const list = orders.listOrders(dir, { pendingOnly: rest.includes('--pending') }).reverse(); // oldest first
    if (rest.includes('--json')) { out(JSON.stringify(list, null, 2)); return 0; }
    remind();
    if (!list.length) { out(rest.includes('--pending') ? 'no pending orders' : 'no orders'); return 0; }
    for (const o of list) {
      out(`${o.id}  ${o.status.padEnd(12)} ${o.kind}${o.target ? ' ' + o.target : ''}  (${o.ts})`);
      const p = payloadLine(o);
      if (p) out(`    ${p}`);
      if (o.text) out(indent(o.text));
      for (const l of attachmentLines(o)) out(l);
      if (o.note) out(`    note: ${o.note}`);
    }
    return 0;
  }
  if (cmd === 'ack') {
    const [id, status, ...note] = rest;
    if (!id || !status) { err(USAGE); return 2; }
    try {
      const a = orders.ackOrder(dir, id, status, note.join(' '));
      out(`${a.id} ${a.status}`);
      return 0;
    } catch (e) {
      err('error: ' + e.message);
      return 1;
    }
  }
  if (cmd === 'reply') {
    const [to, ...args] = rest;
    if (!to) { err(USAGE); return 2; }
    let file = null;
    let ack = null;
    const attach = [];
    const words = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--file' && i + 1 < args.length) file = args[++i];
      else if (args[i] === '--ack' && i + 1 < args.length) ack = args[++i];
      else if (args[i] === '--attach' && i + 1 < args.length) attach.push(args[++i]);
      else words.push(args[i]);
    }
    if (ack && !orders.ACK_STATUSES.includes(ack)) { err(`error: --ack must be one of: ${orders.ACK_STATUSES.join(', ')}`); return 2; }
    if (ack && to === '-') { err('error: --ack needs an order id'); return 2; }
    try {
      let text = words.join(' ');
      if (file !== null) text = readFile(file) + (text ? '\n\n' + text : '');
      const r = orders.createReply(dir, to, text, { attach });
      if (ack) orders.ackOrder(dir, to, ack, '');
      out(`${r.id} reply${r.inReplyTo ? ' to ' + r.inReplyTo : ''}${ack ? ' (' + ack + ')' : ''}`);
      for (const l of attachmentLines(r)) out(l);
      return 0;
    } catch (e) {
      err('error: ' + e.message);
      return 1;
    }
  }
  if (cmd === 'thread') {
    let limit = 30;
    const li = rest.indexOf('--limit');
    if (li >= 0) limit = Number(rest[li + 1]);
    if (!Number.isInteger(limit) || limit < 0) { err(USAGE); return 2; }
    const items = orders.buildThread(dir, { limit });
    if (rest.includes('--json')) { out(JSON.stringify(items, null, 2)); return 0; }
    remind();
    if (!items.length) { out('no messages'); return 0; }
    for (const x of items) {
      if (x.type === 'reply') out(`${x.ts}  first mate${x.inReplyTo ? ' (re ' + x.inReplyTo + ')' : ''}  ${x.id}`);
      else out(`${x.ts}  captain ${x.kind}${x.target ? ' ' + x.target : ''} [${x.status}]  ${x.id}`);
      if (x.text) out(indent(x.text));
      for (const l of attachmentLines(x)) out(l);
    }
    return 0;
  }
  if (cmd === 'sessions') {
    const map = sessions.loadSessions(dir);
    if (rest.includes('--json')) { out(JSON.stringify(map, null, 2)); return 0; }
    const keys = Object.keys(map);
    if (!keys.length) { out('no sessions recorded yet (Ship Deck records them while it runs)'); return 0; }
    for (const id of keys.sort((a, b) => (a === sessions.FIRST_MATE_KEY ? -1 : b === sessions.FIRST_MATE_KEY ? 1 : a.localeCompare(b)))) {
      const e = map[id];
      out(`${id === sessions.FIRST_MATE_KEY ? 'first mate' : id}  ${e.harness || 'claude'}  last seen ${e.lastSeen ? new Date(e.lastSeen).toISOString() : '?'}`);
      out(`    ${sessions.resumeCommand(e.cwd, e.sessionId) || '(no resume id)'}`);
    }
    return 0;
  }
  err(USAGE);
  return cmd === '--help' || cmd === '-h' ? 0 : 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
