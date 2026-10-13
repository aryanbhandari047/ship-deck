'use strict';
// Finds the firstmate home to read and the per-home Claude Code dirs, read-only.
// Nothing here runs a command: the captain's name is parsed from git config files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('./sessions');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// A firstmate home has AGENTS.md, bin/fm-spawn.sh and a state/ dir.
function looksLikeHome(dir) {
  if (!dir) return false;
  return isFile(path.join(dir, 'AGENTS.md')) && isFile(path.join(dir, 'bin', 'fm-spawn.sh')) && isDir(path.join(dir, 'state'));
}

// { home, source, checked }: --home, then FM_HOME, then the cwd and ~/firstmate when
// they look like a home. home is null (first-run screen) when nothing matches.
function detectHome({ flag, env = process.env, cwd = process.cwd(), homedir = os.homedir() } = {}) {
  if (flag) return { home: path.resolve(flag), source: 'flag', checked: [] };
  if (env.FM_HOME) return { home: path.resolve(env.FM_HOME), source: 'env', checked: [] };
  const checked = [path.resolve(cwd), path.join(homedir, 'firstmate')];
  if (looksLikeHome(checked[0])) return { home: checked[0], source: 'cwd', checked };
  if (looksLikeHome(checked[1])) return { home: checked[1], source: 'default', checked };
  return { home: null, source: null, checked };
}

// <claudeDir>/projects/<encoded home>: the first encoding that exists, else the documented one.
function claudeProjectDir(claudeDir, home) {
  const dirs = encodeCwd(home).map((enc) => path.join(claudeDir, 'projects', enc));
  return dirs.find(isDir) || dirs[0];
}

// The first mate's auto-memory dir, which Claude Code keeps next to its transcripts.
function memoryDirFor(claudeDir, home) {
  return path.join(claudeProjectDir(claudeDir, home), 'memory');
}

// user.name from one git config file's [user] section; null when absent.
function gitUserName(text) {
  let section = '';
  let name = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    const s = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (s) { section = s[1].toLowerCase(); continue; }
    const kv = /^name\s*=\s*(.*)$/i.exec(line);
    if (section === 'user' && kv) name = kv[1].replace(/\s[#;].*$/, '').replace(/^"(.*)"$/, '$1').trim() || null;
  }
  return name;
}

// The home repo's git dir: <home>/.git, or the dir a worktree's .git file points to.
function gitDir(home) {
  const dotgit = path.join(home, '.git');
  if (isDir(dotgit)) return dotgit;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (m) return path.resolve(home, m[1].trim());
  } catch { /* not a repo */ }
  return null;
}

// What `git config user.name` would print in the home: repo config, then global, then XDG.
function captainName(home, { homedir = os.homedir(), env = process.env } = {}) {
  const files = [];
  const gd = home && gitDir(home);
  if (gd) {
    files.push(path.join(gd, 'config'));
    const common = (() => { try { return fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim(); } catch { return null; } })();
    if (common) files.push(path.join(path.resolve(gd, common), 'config'));
  }
  files.push(path.join(homedir, '.gitconfig'), path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'git', 'config'));
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const n = gitUserName(text);
    if (n) return n.slice(0, 60);
  }
  return null;
}

module.exports = { looksLikeHome, detectHome, claudeProjectDir, memoryDirFor, gitUserName, captainName };
