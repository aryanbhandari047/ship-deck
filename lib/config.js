'use strict';
// Per-worker model/effort configuration. Values are allow-listed per harness;
// a live change is one slash command sent through fm-send, built here from the
// allow-listed value only (the client names a field and a value, never text).

const HARNESSES = ['claude', 'codex', 'grok', 'pi', 'opencode'];
// harness -> field -> allowed values; null means "show current only"; live = slash commands work.
const ALLOWED = {
  claude: {
    live: true,
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    model: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'],
  },
  codex: { live: false, effort: ['low', 'medium', 'high', 'xhigh'], model: null },
  grok: { live: false, effort: ['low', 'medium', 'high'], model: null },
  pi: { live: false, effort: null, model: null },
  opencode: { live: false, effort: null, model: null },
};
const FIELDS = ['effort', 'model'];
const AUTO = 'auto'; // new jobs only: the first mate decides

// The allowed values for a harness field, or null when it cannot be changed.
function allowed(harness, field) {
  const h = ALLOWED[harness];
  return h && FIELDS.includes(field) && Array.isArray(h[field]) ? h[field] : null;
}

// Throws a user-facing Error unless value is allow-listed for harness/field.
function checkConfig(harness, field, value) {
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness: ${harness || '(none)'}`);
  if (!FIELDS.includes(field)) throw new Error('field must be effort or model');
  const list = allowed(harness, field);
  if (!list) throw new Error(`${field} cannot be changed for ${harness} workers`);
  if (typeof value !== 'string' || !list.includes(value)) throw new Error(`${field} must be one of: ${list.join(', ')}`);
  return { harness, field, value };
}

function canApplyLive(harness) {
  return !!(ALLOWED[harness] && ALLOWED[harness].live);
}

// The exact fm-send message for a live change: "/effort high" or "/model claude-opus-5-5".
function slashCommand(harness, field, value) {
  const v = checkConfig(harness, field, value);
  if (!canApplyLive(harness)) throw new Error(`${harness} workers cannot be changed live`);
  return `/${v.field} ${v.value}`;
}

// Optional harness/model/effort for a new job: model '' = first mate default, effort 'auto'.
function checkJobConfig({ harness, model, effort } = {}) {
  const out = {};
  if (harness === undefined || harness === null || harness === '') return out;
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness: ${harness}`);
  out.harness = harness;
  if (model !== undefined && model !== null && model !== '') out.model = checkConfig(harness, 'model', model).value;
  if (effort !== undefined && effort !== null && effort !== '' && effort !== AUTO) out.effort = checkConfig(harness, 'effort', effort).value;
  else out.effort = AUTO;
  return out;
}

// Current config: meta values, overridden by the latest applied config order;
// unapplied ones show as pending (the first mate applies them on relaunch).
// list: merged orders, newest first.
function currentConfig(task, list) {
  const cur = { harness: task.harness || 'claude', model: task.model || null, effort: task.effort || null, pending: {}, changedAt: {} };
  const mine = (list || []).filter((o) => o.kind === 'config' && o.target === task.id && FIELDS.includes(o.field)).slice().reverse();
  for (const o of mine) {
    if (o.status === 'declined') continue;
    if (o.applied || o.status === 'done') {
      cur[o.field] = o.value;
      cur.changedAt[o.field] = o.ts;
      delete cur.pending[o.field];
    } else {
      cur.pending[o.field] = o.value;
    }
  }
  return cur;
}

// The allow-list as the UI needs it.
function options() {
  const out = {};
  for (const h of HARNESSES) out[h] = { live: ALLOWED[h].live, effort: ALLOWED[h].effort, model: ALLOWED[h].model };
  return out;
}

module.exports = { HARNESSES, FIELDS, AUTO, allowed, checkConfig, canApplyLive, slashCommand, checkJobConfig, currentConfig, options };
