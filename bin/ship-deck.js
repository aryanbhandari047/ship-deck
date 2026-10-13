#!/usr/bin/env node
'use strict';
// `npx ship-deck` / `ship-deck` entry: same flags as `node server.js` (see --help).
require('../server').main(process.argv.slice(2));
