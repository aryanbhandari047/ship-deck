'use strict';
// The captain's Ship Deck preferences: ~/.ship-deck/settings.json (0600), beside share.json.
// Today one field: the form of address the deck and the first mate use ("Captain" unless changed;
// an empty string means no title at all). Ship Deck's own file, never anything under FM_HOME.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'settings.json';
const DEFAULT_ADDRESS = 'Captain';
const MAX_ADDRESS = 40;

// One line, no control characters, at most MAX_ADDRESS characters. Throws Error with a
// user-facing message; '' (no title) is a valid answer.
function cleanAddress(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error('the form of address must be text');
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...s].length > MAX_ADDRESS) throw new Error(`keep it under ${MAX_ADDRESS} characters`);
  return s;
}

function readSettings(dir) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) || {}; } catch { /* missing or junk: defaults */ }
  let address = DEFAULT_ADDRESS;
  if (typeof raw.address === 'string') {
    try { address = cleanAddress(raw.address); } catch { /* hand-edited and too long: default */ }
  }
  return { address };
}

// Merges a validated patch into the file (atomic write) and returns the new settings.
function writeSettings(dir, patch = {}) {
  const next = { ...readSettings(dir) };
  if (Object.prototype.hasOwnProperty.call(patch, 'address')) next.address = cleanAddress(patch.address);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

// What the first mate is told when the captain changes it (the text of an `address` order).
function addressMessage(address) {
  return address
    ? `Please call me "${address}" from now on (my Ship Deck setting). Use it when you address me in replies and messages.`
    : 'Please don\'t use a title or name when you address me from now on (my Ship Deck setting). Just talk to me directly.';
}

// Picker suggestions: Captain, Boss, the first name from the captain's name, and none.
function suggestions(captainName) {
  const first = String(captainName || '').trim().split(/\s+/)[0] || '';
  return [...new Set([DEFAULT_ADDRESS, 'Boss', first].filter(Boolean)), ''];
}

module.exports = { FILE, DEFAULT_ADDRESS, MAX_ADDRESS, cleanAddress, readSettings, writeSettings, addressMessage, suggestions };
