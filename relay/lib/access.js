'use strict';
// Grants: who may see which scopes of whose deck, for which projects, until when. Pure functions;
// lib/app.js stores grants inside the captain's record (cap:<sub>) and calls checkAccess on
// every viewer request. Default deny: no grant, no data.
const { SCOPES } = require('./snapshot');
const { emailAllowed, normalizeEmail } = require('../auth/domain');
const { randomId } = require('../auth/tokens');

const MAX_DAYS = 30;
const DAY = 86400e3;
// Never grantable, whatever a client sends.
const NEVER = ['attachments', 'paths', 'sessions', 'sending'];

class GrantError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// PUT body -> a grant for viewerEmail. Expiry is capped at 30 days from now.
function validateGrant(viewer, body, { domain, captainEmail, now = Date.now(), previous = null }) {
  const email = normalizeEmail(viewer);
  if (!emailAllowed(email, domain)) throw new GrantError(`Grants are for @${domain} emails only.`);
  if (captainEmail && email === normalizeEmail(captainEmail)) throw new GrantError('That is your own email.');
  const b = body && typeof body === 'object' ? body : {};
  const asked = Array.isArray(b.scopes) ? b.scopes : [];
  if (asked.some((x) => NEVER.includes(x))) throw new GrantError('Attachments, paths, sessions and sending are never shared.');
  const scopes = SCOPES.filter((x) => asked.includes(x));
  if (!scopes.length) throw new GrantError('Choose at least one thing to share.');
  if (scopes.includes('suggest') && !scopes.includes('board')) throw new GrantError('Suggesting answers needs the Board.');
  const projects = (Array.isArray(b.projects) ? b.projects : []).filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().slice(0, 100)).slice(0, 50);
  if (!projects.length) throw new GrantError('Choose at least one project.');
  const max = now + MAX_DAYS * DAY;
  let expiresAt = Number(b.expiresAt);
  if (!Number.isFinite(expiresAt)) expiresAt = max;
  if (expiresAt <= now) throw new GrantError('The end date is in the past.');
  expiresAt = Math.min(expiresAt, max);
  const same = previous && previous.viewerEmail === email;
  return {
    viewerEmail: email,
    // A grant's identity across edits; a revoke and re-grant makes a new one (agent keys bind to it).
    gid: (same && previous.gid) || randomId(9),
    viewerSub: same ? previous.viewerSub || null : null,
    scopes,
    projects: projects.includes('*') ? ['*'] : projects,
    // Notes and memory: only the notes the captain marked Share (relay/lib/library.js itemAllowed).
    notesTagged: (scopes.includes('notes') || scopes.includes('ask')) && b.notesTagged === true,
    expiresAt,
    createdAt: (previous && previous.createdAt) || now,
    updatedAt: now,
  };
}

// The grant for this viewer in a captain record, bound by email until first use, then by sub too.
function findGrant(cap, viewer) {
  if (!cap || !cap.grants || !viewer) return null;
  const g = cap.grants[normalizeEmail(viewer.email)];
  if (!g) return null;
  if (g.viewerSub && g.viewerSub !== viewer.sub) return null; // the email now belongs to someone else
  return g;
}

// -> { ok: true, grant } or { ok: false, reason } with reason one of: 'no access', 'expired',
// 'not shared' (scope), 'project not shared'. project: the worker's project when one is named.
function checkAccess({ cap, viewer, scope, project, domain, now = Date.now() }) {
  if (!viewer || !emailAllowed(viewer.email, domain)) return { ok: false, reason: 'no access' };
  const grant = findGrant(cap, viewer);
  if (!grant) return { ok: false, reason: 'no access' };
  if (!(grant.expiresAt > now)) return { ok: false, reason: 'expired' };
  if (!SCOPES.includes(scope) || !grant.scopes.includes(scope)) return { ok: false, reason: 'not shared' };
  if (project !== undefined) {
    const all = grant.projects.includes('*');
    if (!all && !grant.projects.some((p) => p.toLowerCase() === String(project || '').toLowerCase())) return { ok: false, reason: 'project not shared' };
  }
  return { ok: true, grant };
}

// Grants made before gid existed fall back to their creation time.
const grantId = (g) => (g ? g.gid || 'c' + g.createdAt : null);

module.exports = { grantId, MAX_DAYS, NEVER, GrantError, validateGrant, findGrant, checkAccess };
