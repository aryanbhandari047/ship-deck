'use strict';
// Fast lane: each new order appends one line to <home>/state/ship-deck-inbox.status so the
// first mate's monitor wakes within one poll. The ONLY write Ship Deck makes under FM_HOME.
const fs = require('node:fs');
const path = require('node:path');

const INBOX = 'ship-deck-inbox.status';
const MAX_TEXT = 80;

function wakeLine(order) {
  const text = String(order.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return `message: ${order.id} ${order.kind} ${text}`.trimEnd() + '\n';
}

// Append-only (O_APPEND, 0644 if created); never creates dirs. Failure is logged and ignored.
function wake(home, order, log = console.error) {
  try {
    fs.appendFileSync(path.join(home, 'state', INBOX), wakeLine(order), { flag: 'a', mode: 0o644 });
    return true;
  } catch (e) {
    log(`ship-deck: wake line not written: ${e.message}`);
    return false;
  }
}

module.exports = { wake, wakeLine, INBOX };
