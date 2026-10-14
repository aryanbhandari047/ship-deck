'use strict';
// The relay's auth seam. A provider proves who someone is and returns { sub, email, name };
// everything after that (sessions, deck tokens, the @keychain.com rule, grants) is shared.
//
// Provider shape:
//   id                                   'password' today; 'google' can be added later
//   login({ email, password, ip })        -> identity, or throws AuthError (401 / 429 lockout)
//   createInvite({ email, by })           -> { link, expiresAt }   (optional: invite-based providers)
//   acceptInvite({ token, password, destroyAllSessions }) -> identity (optional)
// A Google OIDC provider would add its redirect routes and return the same identity after
// checking hd and email_verified server-side; the app keeps calling emailAllowed() regardless.
const { createPasswordAuth, AuthError } = require('./password');
const { createSessions, readCookie } = require('./sessions');
const { emailAllowed, normalizeEmail } = require('./domain');
const tokens = require('./tokens');

const PROVIDERS = { password: createPasswordAuth };

function createAuth({ store, config, now = Date.now, onEvent }) {
  const make = PROVIDERS[config.authProvider || 'password'];
  if (!make) throw new Error('unknown AUTH_PROVIDER ' + config.authProvider);
  const provider = make({ store, config, now, onEvent });
  const sessions = createSessions({ store, now });
  return {
    provider,
    sessions,
    readCookie,
    emailAllowed: (e) => emailAllowed(e, config.domain),
    normalizeEmail,
    signDeckToken: (claims) => tokens.signDeckToken(config.sessionSecret, claims, now()),
    verifyDeckToken: (t) => tokens.verifyDeckToken(config.sessionSecret, t),
  };
}

module.exports = { createAuth, AuthError, PROVIDERS };
