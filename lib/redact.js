'use strict';
// Redaction for read-only sharing (lib/share.js): every free-text field leaving the laptop goes
// through redact(). It is a scrubber behind an allow-list, not a replacement for one: secrets,
// paths and links are replaced by visible markers like "[token hidden]".
const os = require('node:os');

const MARK = {
  token: '[token hidden]',
  key: '[key hidden]',
  secret: '[secret hidden]',
  path: '[path hidden]',
  link: '[link hidden]',
};
const MARK_RE = /\[(?:token|key|secret|path|link) hidden\]/g;
// Hosts whose links survive (query and fragment are always dropped). Subdomains count.
const DEFAULT_HOSTS = ['github.com', 'linear.app'];

// ANSI escape sequences (CSI, OSC, other ESC pairs) and control characters other than \n and \t.
function stripAnsi(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// Known token shapes. Order matters only for overlap; each becomes [token hidden].
const TOKEN_RES = [
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, // JWT
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, // GitHub
  /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm
  /\bya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth access token
];
const SECRET_WORDS = 'password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|session[_-]?id|cookie|auth';
const KV_RE = new RegExp(`\\b([A-Za-z0-9_.-]*(?:${SECRET_WORDS}))(\\s*[=:]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;&]+)`, 'gi');
const PATH_ROOTS = 'Users|home|etc|var|tmp|opt|private|Volumes|root|srv|mnt|usr|Library|System|Applications|workspace|workspaces';
// Absolute paths: two or more segments, or one under a well-known root. The lead group keeps
// the character before the path (start, space, quote, bracket, = or :).
const ABS_PATH_RE = new RegExp(`(^|[\\s"'\`(=:,\\[{<])(\\/(?:${PATH_ROOTS})\\b[^\\s"'\`<>)\\]},;]*|(?:\\/[\\w.@+%~-]+){2,}\\/?)`, 'g');
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>|]*/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const RUN_RE = /[A-Za-z0-9+/_=-]{32,}/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shannon entropy in bits per character.
function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}
// A run of 32+ characters that looks random: letters and digits mixed, entropy >= 3.5.
function looksSecret(run) {
  return run.length >= 32 && /[A-Za-z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 3.5;
}

function hostAllowed(host, hosts) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return hosts.some((a) => h === a || h.endsWith('.' + a));
}

// Scrubs one free-text value. opts.home: the home dir shown as ~ (default os.homedir());
// opts.hosts: link hosts kept (default github.com, linear.app).
function redact(input, opts = {}) {
  const home = opts.home === undefined ? os.homedir() : opts.home;
  const hosts = opts.hosts || DEFAULT_HOSTS;
  // \u0000 marks protected spans below, so it may not appear in the input.
  let s = stripAnsi(input).replace(/\u0000/g, '');
  const kept = [];
  const keep = (v) => `\u0000${kept.push(v) - 1}\u0000`;

  s = s.replace(/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g, () => keep(MARK.key));
  s = s.replace(URL_RE, (raw) => {
    const tail = /[).,;:!?\]]+$/.exec(raw);
    const url = tail ? raw.slice(0, -tail[0].length) : raw;
    let u;
    try { u = new URL(url); } catch { return keep(MARK.link) + (tail ? tail[0] : ''); }
    const ok = (u.protocol === 'https:' || u.protocol === 'http:') && hostAllowed(u.hostname, hosts);
    return (ok ? keep(scrubSecrets(`${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`, keep)) : keep(MARK.link)) + (tail ? tail[0] : '');
  });
  s = scrubSecrets(s, keep);
  if (home && home !== '/') s = s.replace(new RegExp(escapeRe(home) + '(?=[/\\\\\\s"\'`)\\]},;:]|$)', 'g'), '~');
  s = s.replace(ABS_PATH_RE, (m, lead) => lead + keep(MARK.path));
  s = s.replace(WIN_PATH_RE, () => keep(MARK.path));
  s = s.replace(RUN_RE, (run) => (looksSecret(run) ? keep(MARK.secret) : run));
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
}

function scrubSecrets(s, keep) {
  for (const re of TOKEN_RES) s = s.replace(re, () => keep(MARK.token));
  s = s.replace(/\b((?:proxy-)?authorization)(\s*[:=]\s*)[^\n"'`]*/gi, (m, k, sep) => k + sep + keep(MARK.token));
  s = s.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => 'Bearer ' + keep(MARK.token));
  s = s.replace(KV_RE, (m, k, sep) => k + sep + keep(MARK.secret));
  return s;
}

// Caps a string at max characters with an ellipsis.
function cap(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

module.exports = { MARK, MARK_RE, DEFAULT_HOSTS, stripAnsi, redact, entropy, looksSecret, cap };
