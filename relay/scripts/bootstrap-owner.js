#!/usr/bin/env node
'use strict';
// One-time bootstrap: prints an invite link for the first captain, straight into the production
// store. Run on your own machine with the Upstash REST env vars and PUBLIC_BASE_URL set:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... PUBLIC_BASE_URL=https://<relay> \
//     node scripts/bootstrap-owner.js you@keychain.com
// Open the link (24 h, single use) and set your password. Later teammates are invited from
// Ship Deck's Settings page; running this again for the same email is a password reset.
const { loadConfig } = require('../lib/config');
const { createUpstashStore } = require('../lib/store');
const { createPasswordAuth } = require('../auth/password');

async function main(argv) {
  const email = argv[0];
  const config = loadConfig();
  if (!email) throw new Error('usage: node scripts/bootstrap-owner.js you@keychain.com');
  if (!/^https:\/\//.test(config.baseUrl) && !process.env.PUBLIC_BASE_URL) throw new Error('set PUBLIC_BASE_URL to the relay URL');
  const store = createUpstashStore(config.upstash);
  const inv = await createPasswordAuth({ store, config }).createInvite({ email, by: 'bootstrap' });
  console.log(`Invite for ${inv.email} (expires ${new Date(inv.expiresAt).toISOString()}, single use):\n${inv.link}`);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
