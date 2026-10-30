'use strict';
// The relay's copy of the share allow-list (the deck's is lib/share.js; test/share.test.js keeps
// the two in step). Pushed snapshots are rebuilt field by field, so a deck bug or a forged push
// can never store anything outside the list, and each viewer gets only their scopes and projects.

const SCOPES = ['board', 'updates', 'model', 'skills', 'terminal', 'notes', 'chat', 'ask', 'suggest'];
const WORKER_KEYS = ['ref', 'id', 'title', 'project', 'state', 'quietDays', 'summary', 'updatedAt', 'options', 'pr', 'model', 'effort'];
const SNAPSHOT_KEYS = ['v', 'at', 'scopes', 'projects', 'hiddenProjects', 'fleet', 'workers', 'updates', 'terminal', 'skills', 'notes', 'chat', 'activity', 'trimmed'];
const STATES = ['needs-decision', 'blocked', 'failed', 'working', 'resolved', 'paused', 'unknown', 'done'];
const MAX_BYTES = 64 * 1024;
const REF_RE = /^[A-Za-z0-9_-]{8,32}$/;

const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const lower = (x) => String(x || '').toLowerCase();

function cleanWorker(w) {
  if (!w || typeof w !== 'object' || !REF_RE.test(w.ref)) return null;
  let pr = null;
  if (w.pr && typeof w.pr === 'object') {
    const url = s(w.pr.url, 300);
    pr = { number: n(w.pr.number), url: url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url) ? url : null, ci: s(w.pr.ci, 20) };
  }
  return {
    ref: w.ref,
    id: s(w.id, 80),
    title: s(w.title, 120),
    project: s(w.project, 100),
    state: STATES.includes(w.state) ? w.state : 'unknown',
    quietDays: n(w.quietDays),
    summary: s(w.summary, 200),
    updatedAt: n(w.updatedAt),
    options: arr(w.options, 8).filter((o) => o && typeof o === 'object').map((o) => ({ letter: /^[A-Z?]$/.test(o.letter) ? o.letter : '?', text: s(o.text, 200) })),
    pr,
    model: s(w.model, 60),
    effort: s(w.effort, 60),
  };
}

const byRef = (v, refs, clean) => {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const r of Object.keys(v)) if (refs.has(r)) out[r] = clean(v[r]);
  return out;
};

// A pushed body -> the stored snapshot (or throws on a shape the deck never sends).
function sanitizeSnapshot(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || body.v !== 1) throw new Error('unsupported snapshot');
  const workers = arr(body.workers, 300).map(cleanWorker).filter(Boolean);
  const refs = new Set(workers.map((w) => w.ref));
  const fleet = body.fleet && typeof body.fleet === 'object' ? body.fleet : {};
  const counts = {};
  for (const k of ['needs', 'working', 'waiting', 'done', 'quiet']) counts[k] = n(fleet.counts && fleet.counts[k]) || 0;
  const fm = fleet.firstMate && typeof fleet.firstMate === 'object' ? { state: fleet.firstMate.state === 'working' ? 'working' : 'idle', since: n(fleet.firstMate.since) } : null;
  const out = {
    v: 1,
    at: now, // the relay's clock, not the deck's
    scopes: arr(body.scopes, 10).filter((x) => SCOPES.includes(x)),
    projects: arr(body.projects, 50).filter((p) => typeof p === 'string').map((p) => p.slice(0, 100)),
    hiddenProjects: n(body.hiddenProjects) || 0,
    fleet: { counts, firstMate: fm, monitoring: fleet.monitoring === 'ok' ? 'ok' : 'late' },
    workers,
  };
  if (body.updates) {
    out.updates = byRef(body.updates, refs, (list) => arr(list, 5).filter((e) => e && typeof e === 'object').map((e) => ({ ts: s(e.ts, 25), state: STATES.includes(e.state) ? e.state : 'unknown', note: s(e.note, 200) })));
  }
  if (body.terminal) {
    out.terminal = byRef(body.terminal, refs, (t) => ({ at: n(t && t.at), lines: arr(t && t.lines, 40).map((l) => s(l, 240) || '') }));
  }
  if (body.skills) out.skills = arr(body.skills, 100).filter((x) => x && typeof x === 'object').map((x) => ({ key: s(x.key, 120), title: s(x.title, 120), description: s(x.description, 300) }));
  if (body.notes) out.notes = arr(body.notes, 40).filter((x) => x && typeof x === 'object').map((x) => ({ key: s(x.key, 120), title: s(x.title, 120), text: s(x.text, 8000), shortened: x.shortened === true || undefined, tag: x.tag === 'share' ? 'share' : undefined }));
  if (body.chat) out.chat = arr(body.chat, 30).filter((x) => x && typeof x === 'object').map((x) => ({ ts: s(x.ts, 30), from: x.from === 'firstmate' ? 'firstmate' : 'captain', text: s(x.text, 500) }));
  if (body.activity) out.activity = arr(body.activity, 30).filter((x) => x && typeof x === 'object').map((x) => ({ ts: n(x.ts), label: s(x.label, 160) }));
  if (body.trimmed) out.trimmed = arr(body.trimmed, 10).filter((x) => typeof x === 'string').map((x) => x.slice(0, 20));
  return out;
}

function sharedProject(name, projects) {
  if ((projects || []).includes('*')) return true;
  if (!name) return false;
  return projects.some((p) => lower(p) === lower(name));
}

const COLUMN = { 'needs-decision': 'needs', blocked: 'needs', failed: 'needs', working: 'working', resolved: 'working', done: 'done' };

// One viewer's view of one scope. grant: { scopes, projects }. ref: one worker (updates/terminal).
// Returns { data } or { refused: 'project not shared' | 'not found' }.
function viewFor(snap, grant, scope, ref) {
  const visible = snap.workers.filter((w) => sharedProject(w.project, grant.projects));
  const refs = new Set(visible.map((w) => w.ref));
  if (ref) {
    if (!refs.has(ref)) return { refused: snap.workers.some((w) => w.ref === ref) ? 'project not shared' : 'not found' };
  }
  const pick = (map) => {
    const out = {};
    for (const r of ref ? [ref] : refs) if (map && map[r]) out[r] = map[r];
    return out;
  };
  const withModel = grant.scopes.includes('model');
  switch (scope) {
    case 'board': {
      const counts = { needs: 0, working: 0, waiting: 0, done: 0, quiet: 0 };
      for (const w of visible) counts[w.quietDays !== null ? 'quiet' : COLUMN[w.state] || 'waiting']++;
      const hiddenHere = new Set(snap.workers.filter((w) => !refs.has(w.ref)).map((w) => lower(w.project || 'unassigned')));
      return {
        data: {
          fleet: { ...snap.fleet, counts },
          hiddenProjects: snap.hiddenProjects + hiddenHere.size,
          workers: visible.map((w) => (withModel ? w : { ...w, model: undefined, effort: undefined })),
          trimmed: snap.trimmed || undefined,
        },
      };
    }
    case 'model': return { data: { workers: visible.map((w) => ({ ref: w.ref, model: w.model, effort: w.effort })) } };
    case 'updates': return { data: { updates: pick(snap.updates) } };
    case 'terminal': return { data: { terminal: pick(snap.terminal) } };
    case 'skills': return { data: { skills: snap.skills || [] } };
    case 'notes': return { data: { notes: (snap.notes || []).filter((x) => !grant.notesTagged || x.tag === 'share') } };
    case 'chat': return { data: { chat: snap.chat || [], activity: snap.activity || [] } };
    default: return { refused: 'not found' };
  }
}

module.exports = { SCOPES, WORKER_KEYS, SNAPSHOT_KEYS, MAX_BYTES, REF_RE, sanitizeSnapshot, viewFor, sharedProject, cleanWorker };
