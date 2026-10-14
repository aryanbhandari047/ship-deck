'use strict';
// Knowledge shared with me: the share agent (lib/share.js) hands this module what teammates
// granted (their skills, notes and memory, already redacted by their deck) and it writes them as
// read-only skills for this computer's Claude Code: <claude>/skills/teammate-<captain>-<skill>/.
// It only ever writes, rewrites or removes teammate-* directories carrying its MARKER file;
// any other skill directory (or a symlink) is never touched, even on a name clash.
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./library');

const MARKER = '.ship-deck-teammate.json';
const DIR_RE = /^teammate-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64; // Claude Code's limit for a skill name (the directory name too)
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

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

// What to write for one deck: [{ dir, kind, key, title, text }].
// deck: { captainSub, name, items: [{ key, kind, title, description, text }] } from the relay;
// taken: directory names on disk that are not this captain's (takenDirs).
function planDeck(deck, slug, at, taken = new Set()) {
  const captain = captainName(deck.name);
  const items = Array.isArray(deck.items) ? deck.items.filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string') : [];
  const used = new Set(taken);
  const out = [];
  const notes = items.filter((i) => i.kind !== 'skill');
  if (notes.length) {
    const dir = skillDir(slug, 'notes', used); // teammate-<slug>-notes unless that is taken
    const first = captain.split(' ')[0];
    const desc = `Notes and memory ${captain} shared through Ship Deck: their preferences, learnings and first mate memory. Use when working with ${first} or on their projects, or to see how they like things done.`;
    const body = notes.map((n) => `## ${oneLine(n.title, 120) || n.key}\n\n${n.text.trim()}\n`).join('\n');
    out.push({ dir, kind: 'notes', key: 'notes', title: `${captain}'s notes and memory`, text: `${frontmatter(dir, desc)}${header(captain, at)}\n\n${body}` });
  }
  for (const it of items.filter((i) => i.kind === 'skill')) {
    const fm = parseFrontmatter(it.text);
    const dir = skillDir(slug, fm.name || it.title || it.key.split(':').pop(), used);
    const body = it.text.replace(FRONTMATTER_RE, '').trim();
    const title = oneLine(fm.name || it.title, 120) || it.key;
    out.push({ dir, kind: 'skill', key: it.key, title, text: `${frontmatter(dir, fm.description || it.description || `A skill ${captain} shared through Ship Deck.`)}${header(captain, at)}\n\n${body}\n` });
  }
  return out;
}

// The marker of a teammate directory this module wrote, or null (not ours, a symlink, missing).
function readMarker(skillsDir, dir) {
  if (!DIR_RE.test(dir)) return null;
  const p = path.join(skillsDir, dir);
  try {
    if (!fs.lstatSync(p).isDirectory()) return null;
    const m = JSON.parse(fs.readFileSync(path.join(p, MARKER), 'utf8'));
    return m && m.by === 'ship-deck' && typeof m.captainSub === 'string' ? m : null;
  } catch {
    return null;
  }
}
// teammate-* names on disk this captain may not use: someone else's, the user's own, symlinks.
function takenDirs(skillsDir, captainSub) {
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch { return new Set(); }
  return new Set(names.filter((n) => DIR_RE.test(n)).filter((n) => {
    const m = readMarker(skillsDir, n);
    return !m || m.captainSub !== captainSub;
  }));
}
// Every teammate directory with our marker: [{ dir, captainSub, captain, kind, key, title, syncedAt }].
function listTeammateSkills(skillsDir) {
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch { return []; }
  return names.filter((n) => DIR_RE.test(n)).sort().map((dir) => {
    const m = readMarker(skillsDir, dir);
    return m ? { dir, captainSub: m.captainSub, captain: captainName(m.captain), kind: m.kind === 'notes' ? 'notes' : 'skill', key: String(m.key || ''), title: oneLine(m.title, 120), syncedAt: Number(m.syncedAt) || null } : null;
  }).filter(Boolean);
}

// Read-only files: unlink first so a rewrite works on a 0444 file.
function writeFile(p, text) {
  try { fs.unlinkSync(p); } catch { /* new */ }
  fs.writeFileSync(p, text, { mode: 0o444 });
}

// Writes one deck's plan and removes this captain's marked directories that are no longer in it.
// -> { written: [dir], removed: [dir], skipped: [dir] } (skipped: a clash with a skill not ours).
function writeDeck(skillsDir, deck, files, at) {
  const res = { written: [], removed: [], skipped: [] };
  fs.mkdirSync(skillsDir, { recursive: true });
  const keep = new Set();
  for (const f of files) {
    const p = path.join(skillsDir, f.dir);
    if (!DIR_RE.test(f.dir) || path.dirname(p) !== skillsDir) continue;
    let exists = false;
    try { fs.lstatSync(p); exists = true; } catch { /* new */ }
    const mine = exists ? readMarker(skillsDir, f.dir) : null;
    if (exists && (!mine || mine.captainSub !== deck.captainSub)) { res.skipped.push(f.dir); continue; }
    fs.mkdirSync(p, { recursive: true, mode: 0o755 });
    writeFile(path.join(p, 'SKILL.md'), f.text);
    writeFile(path.join(p, MARKER), JSON.stringify({ v: 1, by: 'ship-deck', captainSub: deck.captainSub, captain: captainName(deck.name), kind: f.kind, key: f.key, title: f.title, syncedAt: at }, null, 2) + '\n');
    keep.add(f.dir);
    res.written.push(f.dir);
  }
  res.removed = removeTeammateSkills(skillsDir, (m) => m.captainSub === deck.captainSub && !keep.has(m.dir));
  return res;
}

// Removes marked teammate directories that match (all of them by default). -> [dir]
function removeTeammateSkills(skillsDir, match = () => true) {
  const out = [];
  for (const m of listTeammateSkills(skillsDir)) {
    if (!match(m)) continue;
    try { fs.rmSync(path.join(skillsDir, m.dir), { recursive: true, force: true }); out.push(m.dir); } catch { /* next sync */ }
  }
  return out;
}

module.exports = { MARKER, DIR_RE, slugify, captainSlugs, planDeck, header, readMarker, takenDirs, listTeammateSkills, writeDeck, removeTeammateSkills };
