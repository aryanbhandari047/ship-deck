'use strict';
// "Stay awake with the lid closed" (macOS only): pmset's SleepDisabled flag. caffeinate cannot
// stop lid-close sleep; `pmset -a disablesleep 1` can, and needs admin rights. Ship Deck never
// sees a password: the deck uses the native macOS admin prompt (osascript), the CLI the
// terminal's own sudo prompt. The state shown is always read back from `pmset -g`, never saved.
// Commands: `pmset -g`, `pmset -g batt` (read), and the fixed disablesleep change below.

const { spawnSync } = require('node:child_process');

const PMSET = '/usr/bin/pmset';
const PROMPT_TIMEOUT = 120000;
const PROMPT = 'Ship Deck wants to keep your Mac awake when the lid is closed.';

const supported = (platform = process.platform) => platform === 'darwin';

// `pmset -g` lists "SleepDisabled 1" only while it is set.
function parseSleepDisabled(text) {
  const m = /^\s*SleepDisabled\s+(\d+)/mi.exec(String(text || ''));
  return !!(m && m[1] !== '0');
}

// `pmset -g batt`: "Now drawing from 'AC Power'" / "'Battery Power'", then "...; 76%; ...".
function parsePower(text) {
  const s = String(text || '');
  const src = /drawing from '([^']+)'/i.exec(s);
  const pct = /(\d{1,3})%/.exec(s);
  return {
    charger: src ? /^AC/i.test(src[1]) : null,
    battery: pct ? Number(pct[1]) : null,
  };
}

// { supported, on, charger, battery, error? }; on is null when pmset could not be read.
async function status({ exec, platform } = {}) {
  if (!supported(platform)) return { supported: false, on: false, charger: null, battery: null };
  const g = await exec('pmset', ['-g'], { timeout: 5000 });
  if (g.code !== 0) return { supported: true, on: null, charger: null, battery: null, error: (g.stderr || g.error || 'pmset failed').trim() };
  const b = await exec('pmset', ['-g', 'batt'], { timeout: 5000 });
  return { supported: true, on: parseSleepDisabled(g.stdout), ...parsePower(b.code === 0 ? b.stdout : '') };
}

const pmsetArgs = (on) => ['-a', 'disablesleep', on ? '1' : '0'];
const adminScript = (on) => `do shell script "${PMSET} ${pmsetArgs(on).join(' ')}" with prompt "${PROMPT}" with administrator privileges`;

// Re-reads the state after a change; ok only when it now matches.
async function confirm(on, deps) {
  const s = await status(deps);
  return s.on === on ? { ok: true, status: s } : { ok: false, status: s, error: s.error || 'the setting did not change' };
}

// The deck's route: the native admin dialog. Cancelling it is { cancelled: true }, not an error.
async function setWithPrompt(on, deps = {}) {
  if (!supported(deps.platform)) return { ok: false, error: 'macOS only' };
  const r = await deps.exec('osascript', ['-e', adminScript(!!on)], { timeout: PROMPT_TIMEOUT });
  if (r.code !== 0) {
    const why = (r.stderr || r.error || '').trim();
    if (/-128|cancel/i.test(why)) return { ok: false, cancelled: true, error: 'cancelled' };
    return { ok: false, error: why || `osascript exited ${r.code}` };
  }
  return confirm(!!on, deps);
}

// Terminal sudo with the terminal's own prompt (stdio inherited).
function defaultSudo(args) {
  const r = spawnSync('sudo', args, { stdio: 'inherit' });
  return r.error ? 1 : r.status;
}

const LABEL = 'Stay awake with the lid closed';
function describe(s) {
  if (!s.supported) return `${LABEL}: macOS only.`;
  if (s.on === null) return `${LABEL}: unknown (${s.error})`;
  let line = `${LABEL}: ${s.on ? 'on' : 'off'}`;
  if (s.on && s.charger === false) line += `\n  On battery${s.battery !== null ? ` (${s.battery}%)` : ''}: plug in the charger, or turn it off with: ship-deck awake off`;
  else if (s.on) line += '\n  Keep the Mac on its charger, and don\'t put it in a bag closed (heat).';
  return line;
}

// `ship-deck awake on|off|status`; returns the exit code. A terminal uses sudo, otherwise the
// native dialog (the installer without a terminal, a launcher from Finder).
async function cli(argv, deps = {}) {
  const d = {
    exec: deps.exec,
    platform: deps.platform,
    sudo: deps.sudo || defaultSudo,
    tty: deps.tty !== undefined ? deps.tty : !!process.stdin.isTTY,
    out: deps.out || ((s) => console.log(s)),
    err: deps.err || ((s) => console.error(s)),
  };
  const cmd = argv[0] || 'status';
  if (!['on', 'off', 'status'].includes(cmd) || argv.length > 1) {
    d.err('usage: ship-deck awake on|off|status');
    return 2;
  }
  if (!supported(d.platform)) { d.out(`${LABEL} is macOS only.`); return 0; }
  const before = await status(d);
  if (cmd === 'status') { d.out(describe(before)); return before.on === null ? 1 : 0; }
  const on = cmd === 'on';
  if (before.on === on) { d.out(describe(before)); return 0; }
  d.out(on ? 'Keeping the Mac awake with the lid closed. macOS asks for your password once.' : 'Restoring normal sleep. macOS asks for your password once.');
  let r;
  if (d.tty) {
    const code = d.sudo([PMSET, ...pmsetArgs(on)]);
    r = code === 0 ? await confirm(on, d) : { ok: false, error: `sudo exited ${code}` };
  } else {
    r = await setWithPrompt(on, d);
  }
  if (!r.ok) {
    d.err(r.cancelled ? 'Cancelled; nothing changed.' : `Could not change it: ${r.error}`);
    return 1;
  }
  d.out(describe(r.status));
  return 0;
}

module.exports = { PMSET, PROMPT, supported, parseSleepDisabled, parsePower, status, adminScript, setWithPrompt, describe, cli };
