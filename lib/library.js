'use strict';
// Ship's Library: the first mate's permanent context files, read-only.
// The set of readable files is a fixed allow-list built server-side; the client
// only ever sends an entry key from that list, never a path.

const fs = require('node:fs');
const path = require('node:path');

// [group, path relative to FM_HOME, title on screen]
const HOME_FILES = [
  ['Fleet home', 'AGENTS.md', 'First mate instructions'],
  ['Fleet home', 'data/captain.md', "Captain's preferences"],
  ['Fleet home', 'data/captain-shared.md', 'Shared preferences'],
  ['Fleet home', 'data/learnings.md', 'Learnings'],
  ['Fleet home', 'data/projects.md', 'Projects'],
  ['Fleet home', 'data/secondmates.md', 'Second mates'],
  ['Fleet home', 'data/backlog.md', 'Queue'],
];

// "fleet-habits.md" -> "Fleet habits"; MEMORY.md is the memory index.
function memoryTitle(name) {
  if (name === 'MEMORY.md') return 'Memory index';
  const s = name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}
const MEMORY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/;
const SKILL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_LIBRARY_FILE = 1024 * 1024;
// [key prefix, group] for the two skill roots: ~/.claude/skills and <home>/.agents/skills.
const SKILL_ROOTS = [['skill:captain:', "Captain's skills"], ['skill:firstmate:', 'Firstmate skills']];

// name/description from a SKILL.md YAML frontmatter (plain, quoted or folded scalars).
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text || ''));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[|>][+-]?$/.test(v) || v === '') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      v = block.join(v.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^(["']).*\1$/.test(v)) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
    }
    out[kv[1]] = v;
  }
  return out;
}

function readStart(p, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// <root>/<dir>/SKILL.md for every skill dir, sorted by name.
function listSkills(root) {
  if (!root) return [];
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const dir of names.filter((n) => SKILL_DIR_RE.test(n)).sort()) {
    const p = path.join(root, dir, 'SKILL.md');
    if (!statFile(p)) continue;
    const fm = parseFrontmatter(readStart(p));
    out.push({ dir, path: p, name: fm.name || dir, description: fm.description || '' });
  }
  return out;
}

function statFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

// Every allow-listed entry: { key, group, label, title, where, path, exists, mtime, size }.
// label is the file (or skill) name, title the words on screen and where a short location
// that never includes the absolute path.
// Home files are always listed (missing ones flagged); memory files are the
// *.md files that exist in memoryDir, MEMORY.md first; then skills (with description).
// opts.captainSkills: the captain's skills dir (~/.claude/skills); none when omitted.
function listLibrary(home, memoryDir, opts = {}) {
  const entries = [];
  const add = (key, group, label, p, extra) => {
    const st = statFile(p);
    entries.push({ key, group, label, title: label, where: label, path: p, exists: !!st, mtime: st ? st.mtimeMs : null, size: st ? st.size : null, ...extra });
  };
  for (const [group, rel, title] of HOME_FILES) add('home:' + rel, group, rel, path.join(home, rel), { title, where: rel });
  if (memoryDir) {
    let names = null;
    try { names = fs.readdirSync(memoryDir); } catch { /* missing dir */ }
    if (names === null) {
      add('memory:MEMORY.md', 'First mate memory', 'MEMORY.md', path.join(memoryDir, 'MEMORY.md'), { title: memoryTitle('MEMORY.md'), where: 'memory/MEMORY.md' });
    } else {
      const md = names.filter((n) => MEMORY_NAME_RE.test(n) && statFile(path.join(memoryDir, n))).sort((a, b) =>
        (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)));
      if (!md.includes('MEMORY.md')) md.unshift('MEMORY.md');
      for (const n of md) add('memory:' + n, 'First mate memory', n, path.join(memoryDir, n), { title: memoryTitle(n), where: 'memory/' + n });
    }
  }
  const roots = [opts.captainSkills || null, path.join(home, '.agents', 'skills')];
  // Skills a teammate shared (lib/knowledge.js marks them) get their own group per teammate.
  const shared = new Map(roots[0] ? require('./knowledge').listTeammateSkills(roots[0]).map((m) => [m.dir, m]) : []);
  const teammate = [];
  SKILL_ROOTS.forEach(([prefix, group], i) => {
    const base = i === 0 ? '~/.claude/skills/' : '.agents/skills/';
    for (const sk of listSkills(roots[i])) {
      const m = i === 0 && shared.get(sk.dir);
      if (m) teammate.push([sk, m, base]);
      else add(prefix + sk.dir, group, sk.name, sk.path, { description: sk.description, where: base + sk.dir + '/SKILL.md' });
    }
  });
  for (const [sk, m, base] of teammate) {
    add('skill:teammate:' + sk.dir, `Shared by ${m.captain}`, sk.name, sk.path, { title: m.title || sk.name, description: sk.description, where: base + sk.dir + '/SKILL.md', teammate: true });
  }
  return entries;
}

// Reads one entry by key, looked up in a freshly built allow-list.
// Returns null for an unknown key; { entry, text: null } when the file is missing.
function readLibraryEntry(home, memoryDir, key, opts = {}) {
  if (typeof key !== 'string') return null;
  const entry = listLibrary(home, memoryDir, opts).find((e) => e.key === key);
  if (!entry) return null;
  if (!entry.exists) return { entry, text: null, truncated: false };
  let fd;
  try {
    fd = fs.openSync(entry.path, 'r');
    const len = Math.min(entry.size, MAX_LIBRARY_FILE);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { entry, text: buf.toString('utf8'), truncated: entry.size > MAX_LIBRARY_FILE };
  } catch {
    return { entry: { ...entry, exists: false }, text: null, truncated: false };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

module.exports = { HOME_FILES, memoryTitle, parseFrontmatter, listSkills, listLibrary, readLibraryEntry };
