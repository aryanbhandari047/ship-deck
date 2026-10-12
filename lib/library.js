'use strict';
// Ship's Library: the first mate's permanent context files, read-only.
// The set of readable files is a fixed allow-list built server-side; the client
// only ever sends an entry key from that list, never a path.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MEMORY_DIR = '/Users/aryanbhandari/.claude/projects/-Users-aryanbhandari-Desktop-AI-firstmate/memory';
// [group, path relative to FM_HOME]
const HOME_FILES = [
  ['Fleet home', 'AGENTS.md'],
  ['Fleet home', 'data/captain.md'],
  ['Fleet home', 'data/captain-shared.md'],
  ['Fleet home', 'data/learnings.md'],
  ['Fleet home', 'data/projects.md'],
  ['Fleet home', 'data/secondmates.md'],
  ['Fleet home', 'data/backlog.md'],
];
const MEMORY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/;
const MAX_LIBRARY_FILE = 1024 * 1024;

function statFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

// Every allow-listed entry: { key, group, label, path, exists, mtime, size }.
// Home files are always listed (missing ones flagged); memory files are the
// *.md files that exist in memoryDir, MEMORY.md first.
function listLibrary(home, memoryDir) {
  const entries = [];
  const add = (key, group, label, p) => {
    const st = statFile(p);
    entries.push({ key, group, label, path: p, exists: !!st, mtime: st ? st.mtimeMs : null, size: st ? st.size : null });
  };
  for (const [group, rel] of HOME_FILES) add('home:' + rel, group, rel, path.join(home, rel));
  if (memoryDir) {
    let names = null;
    try { names = fs.readdirSync(memoryDir); } catch { /* missing dir */ }
    if (names === null) {
      add('memory:MEMORY.md', 'First mate memory', 'MEMORY.md', path.join(memoryDir, 'MEMORY.md'));
    } else {
      const md = names.filter((n) => MEMORY_NAME_RE.test(n) && statFile(path.join(memoryDir, n))).sort((a, b) =>
        (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)));
      if (!md.includes('MEMORY.md')) md.unshift('MEMORY.md');
      for (const n of md) add('memory:' + n, 'First mate memory', n, path.join(memoryDir, n));
    }
  }
  return entries;
}

// Reads one entry by key, looked up in a freshly built allow-list.
// Returns null for an unknown key; { entry, text: null } when the file is missing.
function readLibraryEntry(home, memoryDir, key) {
  if (typeof key !== 'string') return null;
  const entry = listLibrary(home, memoryDir).find((e) => e.key === key);
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

module.exports = { DEFAULT_MEMORY_DIR, HOME_FILES, listLibrary, readLibraryEntry };
