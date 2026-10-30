'use strict';
// Relay settings from the environment (see relay/README.md). Nothing secret has a default.

function loadConfig(env = process.env) {
  const onVercel = !!env.VERCEL;
  return {
    baseUrl: String(env.PUBLIC_BASE_URL || (onVercel ? '' : 'http://localhost:3000')).replace(/\/+$/, ''),
    domain: String(env.ALLOWED_HD || 'keychain.com').trim().toLowerCase(),
    sessionSecret: env.SESSION_SECRET || '',
    ownerEmail: String(env.OWNER_EMAIL || '').trim().toLowerCase() || null,
    // Besides the owner, who approves offers to the team pool (comma-separated emails).
    poolApprovers: String(env.POOL_APPROVERS || ''),
    // One-time owner setup link (GET /api/auth/setup), unset once the owner has an account.
    setupCode: String(env.SETUP_CODE || ''),
    // With SETUP_CODE, lets the link run while accounts exist: an owner password reset.
    setupAllowReset: env.SETUP_ALLOW_RESET === '1',
    authProvider: env.AUTH_PROVIDER || 'password',
    upstash: {
      url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
      token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
    },
    onVercel,
    // Behind Vercel, x-forwarded-for is set by the platform; elsewhere it is ignored.
    trustProxy: onVercel,
  };
}

// Problems that must stop the relay from serving (an empty list is fine).
function configProblems(c) {
  const out = [];
  if (!/^https?:\/\/[^/]+$/.test(c.baseUrl)) out.push('PUBLIC_BASE_URL must be the relay origin, e.g. https://ship-deck-relay.vercel.app');
  if (c.onVercel && !c.baseUrl.startsWith('https://')) out.push('PUBLIC_BASE_URL must be https on Vercel');
  if (String(c.sessionSecret).length < 32) out.push('SESSION_SECRET must be at least 32 random characters');
  if (c.onVercel && !(c.upstash.url && c.upstash.token)) out.push('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(c.domain)) out.push('ALLOWED_HD must be a domain like keychain.com');
  return out;
}

module.exports = { loadConfig, configProblems };
