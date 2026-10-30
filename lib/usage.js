'use strict';
// How often this computer's agent used knowledge teammates shared (lib/knowledge.js entries),
// counted from Claude Code's own transcripts, read only: no hook and no change to the agent's
// config. A use is the Skill tool loading a teammate-* skill, a Read of its SKILL.md, or the
// /teammate-* slash command. Only the entry name and the time leave this module; never a prompt,
// a path or any other text. The share agent maps names to the captain's library keys and
// reports counts (lib/share.js reportUsage). State: <orders dir>/usage.json (offsets per file).
const fs = require('node:fs');
const path = require('node:path');

const NAME_RE = /^teammate-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const READ_RE = /[\\/]skills[\\/](teammate-[a-z0-9]+(?:-[a-z0-9]+)*)[\\/]SKILL\.md$/;
const CMD_RE = /<command-name>\/?(teammate-[a-z0-9]+(?:-[a-z0-9]+)*)<\/command-name>/g;
const LIMITS = { scanBytes: 16 * 1024 * 1024, chunk: 1024 * 1024, seen: 2000, files: 5000, line: 4 * 1024 * 1024 };

// Uses in one transcript line: [{ name, id, ts }]. id de-dupes a line copied into a resumed session.
function usesInLine(line) {
  if (!line.includes('teammate-')) return [];
  let e;
  try { e = JSON.parse(line); } catch { return []; }
  if (!e || typeof e !== 'object' || !e.message) return [];
  const ts = Date.parse(e.timestamp) || null;
  const out = [];
  const content = e.message.content;
  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (!c || c.type !== 'tool_use' || !c.input || typeof c.id !== 'string') continue;
      let name = null;
      if (c.name === 'Skill' && typeof c.input.skill === 'string') name = c.input.skill.replace(/^\//, '');
      else if (c.name === 'Read' && typeof c.input.file_path === 'string') name = (READ_RE.exec(c.input.file_path) || [])[1] || null;
      if (name && NAME_RE.test(name)) out.push({ name, id: c.id.slice(0, 80), ts });
    }
  } else if (e.type === 'user' && typeof content === 'string' && typeof e.uuid === 'string') {
    for (const m of content.matchAll(CMD_RE)) out.push({ name: m[1], id: e.uuid.slice(0, 80) + ':' + m[1], ts });
  }
  return out;
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { files: s.files && typeof s.files === 'object' ? s.files : {}, seen: Array.isArray(s.seen) ? s.seen : [], pending: s.pending && typeof s.pending === 'object' ? s.pending : {} };
  } catch {
    return { files: {}, seen: [], pending: {} };
  }
}
function writeState(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// <projects>/<project>/<session>.jsonl, newest first.
function transcripts(projectsDir) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(projectsDir, d.name)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const rel = d.name + '/' + n;
      try {
        const st = fs.lstatSync(path.join(projectsDir, rel));
        if (st.isFile()) out.push({ rel, size: st.size, mtime: st.mtimeMs });
      } catch { /* gone */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LIMITS.files);
}

// Reads what was appended to the transcripts since the last scan and returns the new uses.
// since: files untouched since then are skipped (no teammate entry existed before it).
// state is updated in place: files { rel: offset }, seen (recent ids).
function scan(projectsDir, state, { since = 0, maxBytes = LIMITS.scanBytes } = {}) {
  const uses = [];
  const seen = new Set(state.seen);
  const live = {};
  let budget = maxBytes;
  for (const f of transcripts(projectsDir)) {
    let offset = Number(state.files[f.rel]) || 0;
    if (offset > f.size) offset = 0; // rewritten
    live[f.rel] = offset;
    if (f.mtime < since || offset === f.size || budget <= 0) continue;
    let fd;
    try {
      fd = fs.openSync(path.join(projectsDir, f.rel), 'r');
      let carry = '';
      while (offset < f.size && budget > 0) {
        const len = Math.min(LIMITS.chunk, f.size - offset);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, offset);
        if (!got) break;
        budget -= got;
        const text = carry + buf.subarray(0, got).toString('utf8');
        const cut = text.lastIndexOf('\n');
        // A line longer than LIMITS.line is skipped rather than held in memory.
        if (cut < 0) { carry = text.length > LIMITS.line ? '' : text; offset += got; if (!carry) live[f.rel] = offset; continue; }
        for (const line of text.slice(0, cut).split('\n')) {
          for (const u of usesInLine(line)) {
            if (seen.has(u.id)) continue;
            seen.add(u.id);
            uses.push(u);
          }
        }
        carry = text.slice(cut + 1);
        offset += got;
        live[f.rel] = offset - Buffer.byteLength(carry);
      }
    } catch { /* unreadable: try again next scan */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  state.files = live;
  state.seen = [...seen].slice(-LIMITS.seen);
  return uses;
}

module.exports = { NAME_RE, LIMITS, usesInLine, scan, readState, writeState };
