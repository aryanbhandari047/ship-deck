'use strict';
// Who may hold an account at all: one exact email domain (ALLOWED_HD, keychain.com), any case.
// Subdomains and look-alikes (keychain.com.evil.io, mail.keychain.com) are refused.

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailAllowed(email, domain) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 1 || e.length > 254) return false;
  return e.slice(at + 1) === String(domain || '').toLowerCase() && /^[a-z0-9._%+-]+$/.test(e.slice(0, at)) && !e.slice(0, at).includes('..');
}

// "grace.example@keychain.com" -> "Grace Example": a display name without asking for one.
function nameFromEmail(email) {
  return normalizeEmail(email).split('@')[0].split(/[._+-]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 80) || 'Teammate';
}

module.exports = { normalizeEmail, emailAllowed, nameFromEmail };
