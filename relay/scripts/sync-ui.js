#!/usr/bin/env node
'use strict';
// Copies the deck's shared UI files into relay/public so the viewer looks like Ship Deck:
// style.css (Chart room tokens), board.js (status flags and columns) and markdown.js (safe renderer).
// The relay deploys on its own, so these are copies; test/share.test.js fails when they drift.
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['style.css', 'board.js', 'markdown.js'];
const from = path.join(__dirname, '..', '..', 'public');
const to = path.join(__dirname, '..', 'public');
for (const f of FILES) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log('synced ' + FILES.join(', '));
module.exports = { FILES };
