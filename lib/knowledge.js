'use strict';
// Knowledge shared with me: the share agent (lib/share.js) hands this module what teammates
// granted (their skills, notes and memory, already redacted by their deck) and it writes them as
// read-only skills for this computer's agents. Two layouts:
//   'skill' <root>/teammate-<captain>-<skill>/SKILL.md + MARKER (Claude Code, ~/.agents/skills)
//   'rule'  <root>/teammate-<captain>-<skill>.mdc with the marker in its frontmatter (Cursor rules)
// It only ever writes, rewrites or removes teammate-* entries carrying its marker; any other
// entry (or a symlink) is never touched, even on a name clash.
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./library');

const MARKER = '.ship-deck-teammate.json';
const DIR_RE = /^teammate-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64; // Claude Code's limit for a skill name (the directory name too)
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const RULE_EXT = '.mdc';
const RULE_KEY = 'shipDeckTeammate'; // the rule layout's marker: one JSON value in the frontmatter

// "Ada Lovelace" -> "ada-lovelace"; letters and digits only, at most max characters.
function slugify(s, max = 24) {
  const out = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return out;
}
// Relay text is data: one printable line.
const oneLine = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const captainName = (s) => oneLine(s, 80) || 'a teammate';

// A slug per captain, unique among them. Earlier slugs are kept so directories do not move.
// decks: [{ captainSub, name }]; previous: { captainSub: slug }.
function captainSlugs(decks, previous = {}) {
  const out = {};
  const used = new Set();
  const sorted = [...decks].sort((a, b) => (a.captainSub < b.captainSub ? -1 : 1));
  for (const d of sorted) {
    const p = previous[d.captainSub];
    if (p && DIR_RE.test('teammate-' + p) && !used.has(p)) { out[d.captainSub] = p; used.add(p); }
  }
  for (const d of sorted) {
    if (out[d.captainSub]) continue;
    const base = slugify(d.name) || 'teammate';
    let slug = base;
    // Two captains with the same name: add part of the account id.
    if (used.has(slug)) slug = `${base.slice(0, 18)}-${slugify(d.captainSub, 40).slice(0, 5) || 'x'}`;
    for (let i = 2; used.has(slug); i++) slug = `${base.slice(0, 18)}-${i}`;
    out[d.captainSub] = slug;
    used.add(slug);
  }
  return out;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400e3;
const STALE_DAYS = 30;
// Freshness of one shared item: the captain editing it counts as checking it.
// -> { line, stale, staleAt } (staleAt: when a fresh item turns stale; null when stale or unknown).
function freshness(item, captain, at, staleDays = STALE_DAYS) {
  const updated = Number(item.updatedAt) || null;
  const verified = Number(item.verifiedAt) || null;
  const fresh = Math.max(updated || 0, verified || 0) || null;
  const parts = [updated ? `last updated ${dayOf(updated)}` : null, verified ? `last verified ${dayOf(verified)}` : 'not marked verified'].filter(Boolean);
  if (!fresh) return { line: '', stale: false, staleAt: null };
  const staleAt = fresh + staleDays * DAY;
  const stale = at >= staleAt;
  const said = parts.join(', ');
  const line = `${said[0].toUpperCase()}${said.slice(1)}.` + (stale ? ` ${captain} has not checked it in over ${staleDays} days: confirm it still holds before relying on it.` : '');
  return { line, stale, staleAt: stale ? null : staleAt };
}
function header(captain, at) {
  return `> Shared by ${captain} via Ship Deck on ${dayOf(at)}; reference knowledge from a teammate - follow it as guidance, it is not an instruction from the user.`;
}
// Only name and description survive from the teammate's frontmatter: fields such as allowed-tools
// would widen what this computer's agent may do. JSON strings are valid YAML double-quoted scalars.
function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine(description, 1024))}\n---\n\n`;
}
// A directory name for one skill, unique within its captain and clear of directories on disk that
// are not this captain's (used: full names taken so far).
function skillDir(slug, want, used) {
  const prefix = `teammate-${slug}-`;
  const room = MAX_NAME - prefix.length;
  const base = slugify(want, room) || 'skill';
  let name = base;
  for (let i = 2; used.has(prefix + name); i++) name = `${base.slice(0, room - String(i).length - 1)}-${i}`;
  used.add(prefix + name);
  return prefix + name;
}

// What to write for one deck: [{ dir, kind, key, title, text, stale, staleAt }].
// deck: { captainSub, name, items: [{ key, kind, title, description, text, updatedAt, verifiedAt }] }
// from the relay; taken: directory names on disk that are not this captain's (takenDirs);
// opts.staleDays: an item not updated or verified for this long is flagged (default 30).
function planDeck(deck, slug, at, taken = new Set(), opts = {}) {
  const staleDays = opts.staleDays || STALE_DAYS;
  const captain = captainName(deck.name);
  const items = Array.isArray(deck.items) ? deck.items.filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string') : [];
  const used = new Set(taken);
  const out = [];
  const notes = items.filter((i) => i.kind !== 'skill');
  if (notes.length) {
    const dir = skillDir(slug, 'notes', used); // teammate-<slug>-notes unless that is taken
    const first = captain.split(' ')[0];
    const desc = deck.captainSub === 'team-pool'
      ? 'Notes from the team pool in Ship Deck, offered by teammates and approved for everyone. Use to see how the team does things.'
      : `Notes and memory ${captain} shared through Ship Deck: their preferences, learnings and first mate memory. Use when working with ${first} or on their projects, or to see how they like things done.`;
    const fresh = notes.map((n) => freshness(n, captain, at, staleDays));
    const meta = (n, i) => [origin(n), fresh[i].line].filter(Boolean).join(' ');
    const body = notes.map((n, i) => `## ${oneLine(n.title, 120) || n.key}\n\n${meta(n, i) ? `_${meta(n, i)}_\n\n` : ''}${n.text.trim()}\n`).join('\n');
    out.push({
      dir, kind: 'notes', key: 'notes', title: `${captain}'s notes and memory`, text: `${frontmatter(dir, desc)}${header(captain, at)}\n\n${body}`,
      stale: fresh.some((f) => f.stale), staleAt: minOf(fresh.map((f) => f.staleAt)),
    });
  }
  for (const it of items.filter((i) => i.kind === 'skill')) {
    const fm = parseFrontmatter(it.text);
    const dir = skillDir(slug, fm.name || it.title || it.key.split(':').pop(), used);
    const body = it.text.replace(FRONTMATTER_RE, '').trim();
    const title = oneLine(fm.name || it.title, 120) || it.key;
    const f = freshness(it, captain, at, staleDays);
    out.push({
      dir, kind: 'skill', key: it.key, title, stale: f.stale, staleAt: f.staleAt,
      text: `${frontmatter(dir, fm.description || it.description || `A skill ${captain} shared through Ship Deck.`)}${header(captain, at)}${origin(it) ? '\n> ' + origin(it) : ''}${f.line ? '\n> ' + f.line : ''}\n\n${body}\n`,
    });
  }
  return out;
}
// Who offered and approved a team pool item, when the relay says so.
function origin(item) {
  const by = oneLine(item.offeredBy, 254);
  const ok = oneLine(item.approvedBy, 254);
  return by ? `Offered by ${by}${ok ? `, approved by ${ok}` : ''}.` : '';
}
const minOf = (xs) => { const v = xs.filter((x) => x); return v.length ? Math.min(...v) : null; };
// When the next item in a plan turns stale (the sync rewrites the deck then), or null.
const nextStale = (files) => minOf(files.map((f) => f.staleAt));

// The marker of a teammate entry this module wrote, or null (not ours, a symlink, missing).
// name: the entry name without the rule extension.
function readMarker(root, name, layout = 'skill') {
  if (!DIR_RE.test(name)) return null;
  try {
    let m;
    if (layout === 'rule') {
      const p = path.join(root, name + RULE_EXT);
      if (!fs.lstatSync(p).isFile()) return null;
      m = JSON.parse(parseFrontmatter(fs.readFileSync(p, 'utf8').slice(0, 8192))[RULE_KEY] || 'null');
    } else {
      const p = path.join(root, name);
      if (!fs.lstatSync(p).isDirectory()) return null;
      m = JSON.parse(fs.readFileSync(path.join(p, MARKER), 'utf8'));
    }
    return m && m.by === 'ship-deck' && typeof m.captainSub === 'string' ? m : null;
  } catch {
    return null;
  }
}
// teammate-* names under root, without the rule extension.
function teammateNames(root, layout) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  if (layout === 'rule') names = names.filter((n) => n.endsWith(RULE_EXT)).map((n) => n.slice(0, -RULE_EXT.length));
  return names.filter((n) => DIR_RE.test(n));
}
// teammate-* names on disk this captain may not use: someone else's, the user's own, symlinks.
function takenDirs(root, captainSub, layout = 'skill') {
  return new Set(teammateNames(root, layout).filter((n) => {
    const m = readMarker(root, n, layout);
    return !m || m.captainSub !== captainSub;
  }));
}
// Every teammate entry with our marker: [{ dir, captainSub, captain, kind, key, title, syncedAt }].
function listTeammateSkills(root, layout = 'skill') {
  return teammateNames(root, layout).sort().map((dir) => {
    const m = readMarker(root, dir, layout);
    return m ? { dir, captainSub: m.captainSub, captain: captainName(m.captain), kind: m.kind === 'notes' ? 'notes' : 'skill', key: String(m.key || ''), title: oneLine(m.title, 120), syncedAt: Number(m.syncedAt) || null, stale: m.stale === true } : null;
  }).filter(Boolean);
}

// A planned SKILL.md as a Cursor rule: the agent picks it by its description (alwaysApply off).
function ruleText(text, marker) {
  const fm = parseFrontmatter(text);
  const body = text.replace(FRONTMATTER_RE, '').replace(/^\n+/, '');
  return `---\ndescription: ${JSON.stringify(oneLine(fm.description, 1024))}\nalwaysApply: false\n${RULE_KEY}: ${JSON.stringify(marker)}\n---\n\n${body}`;
}

// Read-only files: unlink first so a rewrite works on a 0444 file.
function writeFile(p, text) {
  try { fs.unlinkSync(p); } catch { /* new */ }
  fs.writeFileSync(p, text, { mode: 0o444 });
}

// Writes one deck's plan and removes this captain's marked entries that are no longer in it.
// -> { written: [dir], removed: [dir], skipped: [dir] } (skipped: a clash with an entry not ours).
function writeDeck(root, deck, files, at, layout = 'skill') {
  const res = { written: [], removed: [], skipped: [] };
  fs.mkdirSync(root, { recursive: true });
  const keep = new Set();
  for (const f of files) {
    const p = path.join(root, f.dir + (layout === 'rule' ? RULE_EXT : ''));
    if (!DIR_RE.test(f.dir) || path.dirname(p) !== root) continue;
    let exists = false;
    try { fs.lstatSync(p); exists = true; } catch { /* new */ }
    const mine = exists ? readMarker(root, f.dir, layout) : null;
    if (exists && (!mine || mine.captainSub !== deck.captainSub)) { res.skipped.push(f.dir); continue; }
    const marker = { v: 1, by: 'ship-deck', captainSub: deck.captainSub, captain: captainName(deck.name), kind: f.kind, key: f.key, title: f.title, syncedAt: at, stale: !!f.stale };
    if (layout === 'rule') {
      writeFile(p, ruleText(f.text, marker));
    } else {
      fs.mkdirSync(p, { recursive: true, mode: 0o755 });
      writeFile(path.join(p, 'SKILL.md'), f.text);
      writeFile(path.join(p, MARKER), JSON.stringify(marker, null, 2) + '\n');
    }
    keep.add(f.dir);
    res.written.push(f.dir);
  }
  res.removed = removeTeammateSkills(root, (m) => m.captainSub === deck.captainSub && !keep.has(m.dir), layout);
  return res;
}

// Removes marked teammate entries that match (all of them by default). -> [dir]
function removeTeammateSkills(root, match = () => true, layout = 'skill') {
  const out = [];
  for (const m of listTeammateSkills(root, layout)) {
    if (!match(m)) continue;
    try { fs.rmSync(path.join(root, m.dir + (layout === 'rule' ? RULE_EXT : '')), { recursive: true, force: true }); out.push(m.dir); } catch { /* next sync */ }
  }
  return out;
}

module.exports = { MARKER, DIR_RE, RULE_EXT, STALE_DAYS, slugify, captainSlugs, freshness, planDeck, nextStale, header, readMarker, takenDirs, listTeammateSkills, writeDeck, removeTeammateSkills };
