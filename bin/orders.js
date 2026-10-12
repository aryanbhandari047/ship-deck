#!/usr/bin/env node
'use strict';
// Captain's orders queue, for the first mate.
//   node bin/orders.js list [--pending] [--json]
//   node bin/orders.js ack <id> <acknowledged|done|declined> [note...]
// Reads ~/.ship-deck/orders.jsonl; ack appends to ~/.ship-deck/orders-ack.jsonl.
// SHIP_DECK_ORDERS_DIR overrides the directory.

const orders = require('../lib/orders');

const USAGE = 'usage: node bin/orders.js list [--pending] [--json]\n' +
  '       node bin/orders.js ack <id> <' + orders.ACK_STATUSES.join('|') + '> [note...]';

function main(argv, dir = orders.defaultDir(), out = console.log, err = console.error) {
  const [cmd, ...rest] = argv;
  if (cmd === 'list') {
    const bad = rest.filter((a) => a !== '--pending' && a !== '--json');
    if (bad.length) { err(USAGE); return 2; }
    const list = orders.listOrders(dir, { pendingOnly: rest.includes('--pending') }).reverse(); // oldest first
    if (rest.includes('--json')) { out(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { out(rest.includes('--pending') ? 'no pending orders' : 'no orders'); return 0; }
    for (const o of list) {
      out(`${o.id}  ${o.status.padEnd(12)} ${o.kind}${o.target ? ' ' + o.target : ''}  (${o.ts})`);
      out(`    ${o.text}`);
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
  err(USAGE);
  return cmd === '--help' || cmd === '-h' ? 0 : 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
