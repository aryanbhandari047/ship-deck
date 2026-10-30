'use strict';
// Settings > Sharing: sign in to the relay, give and revoke read-only access, read the audit log.
// Everything shown here that came from the relay is set with textContent, never as HTML.

(function () {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SCOPES = [
    { key: 'board', name: 'Board', desc: 'Titles, status, projects, ages, PR links', on: true, col: 0 },
    { key: 'updates', name: 'Updates', desc: 'Status history and one-line summaries', on: true, col: 0 },
    { key: 'model', name: 'Model and effort', desc: 'Which model each worker runs', on: true, col: 0 },
    { key: 'skills', name: 'Skills', desc: 'Your skills, which their agent can use', on: false, col: 0 },
    { key: 'terminal', name: 'Terminal output', desc: 'Last 40 lines, redacted, refreshed every 30 s', on: false, col: 1 },
    { key: 'notes', name: 'Captain notes and memory', desc: 'Your rules for the first mate, which their agent can use too. Read them before sharing.', on: false, col: 1 },
    { key: 'chat', name: 'First mate chat and activity', desc: 'Your conversation and its tool calls', on: false, col: 1 },
    { key: 'ask', name: 'Questions about skills and notes', desc: 'Their agent can ask questions and gets up to 3 short quoted passages each, without copying your skills and notes to them. Each question (redacted) shows in your log. Many questions can piece the text together, so share only what you would let them read.', on: false, col: 0 },
  ];
  const NAME = Object.fromEntries(SCOPES.map((s) => [s.key, s.name]));
  const NEVER = [
    { name: 'Attachments, file paths, session ids', desc: 'Screenshots, recordings, folders, resume commands', word: 'Never shared' },
    { name: 'Sending anything', desc: 'Answers, messages, merges, clean-ups, settings', word: 'Never allowed' },
  ];

  let status = null;
  let grants = []; // the full list from /api/share/grants (with accounts and last views)
  let auditRows = [];
  let usageRows = [];
  let editing = null; // email of the grant being edited
  const chosen = new Set(SCOPES.filter((s) => s.on).map((s) => s.key));
  let projects = null; // Set of chosen project names (null until the first status)
  let notesTagged = false; // Captain notes and memory: only the notes marked Share
  let items = []; // the captain's skills and notes with freshness (/api/share/items)
  let poolData = null; // the team pool (/api/share/pool)

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function icon(id) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  }
  function toast(text, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: err ? 'alert' : 'status' }, icon(err ? 'i-x' : 'i-check'), text);
    $('toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, err ? 6000 : 3000);
  }

  async function get(p) {
    const r = await fetch(p, { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `error ${r.status}`);
    return data;
  }
  async function post(p, body) {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `error ${r.status}`);
    return data;
  }

  // ---------- formatting ----------
  const DAY = 86400e3;
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  function ends(ms) {
    if (!ms) return '';
    const d = ms - Date.now();
    if (d <= 0) return 'Ended ' + fmtDate(ms);
    if (d < DAY) return 'Today, ' + fmtTime(ms);
    return d < 14 * DAY ? `in ${Math.ceil(d / DAY)} days` : fmtDate(ms);
  }
  function ago(ms) {
    if (!ms) return 'Never';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < DAY / 1000) return `${Math.round(s / 3600)} h ago`;
    return fmtDate(ms);
  }
  function when(ms) {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString() ? fmtTime(ms) : `${fmtDate(ms)} ${fmtTime(ms)}`;
  }
  const initials = (s) => String(s || '?').split('@')[0].split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  // ---------- state + top ----------
  function renderState() {
    const box = $('share-state');
    box.textContent = '';
    const s = status;
    const signedIn = !!(s && s.enabled && s.account);
    $('signin-box').hidden = !(s && s.enabled && !s.account);
    for (const id of ['people-box', 'what-box', 'log-box', 'usage-box', 'items-box']) $(id).hidden = !signedIn;
    if (!signedIn) $('pool-box').hidden = true;
    renderKnowledge(signedIn);
    $('share-toggle').hidden = !signedIn;
    if (!s) return;
    if (!s.enabled) {
      box.append(h('div', { class: 'callout warn' }, icon('i-lock'), h('span', null,
        'Sharing is off: Ship Deck sends nothing, and skills teammates share with you do not reach your agent. Turn it back on with ',
        h('code', { text: 'sh ~/ship-deck/bin/install.sh --share' }), ' and restart Ship Deck (installs have it on unless you chose ',
        h('code', { text: '--no-share' }), '). Your deck stays on this computer either way.')));
      return;
    }
    if (s.problem) box.append(h('div', { class: 'callout warn', role: 'status' }, icon('i-lock'), h('span', null, s.problem, s.retryAt ? ` Trying again at ${fmtTime(s.retryAt)}.` : '')));
    if (!signedIn) return;
    $('share-toggle').setAttribute('aria-checked', String(!s.paused));
    $('share-toggle').title = s.paused ? 'Sharing is paused: nothing is sent' : 'Sharing is on';
    const host = (() => { try { return new URL(s.relay).host; } catch { return s.relay; } })();
    const what = s.paused ? 'Sharing is paused: nothing is sent until you turn it back on.'
      : s.viewers ? `Ship Deck sends a redacted snapshot to the relay when your board changes (at most every ${s.timing.minPushSec} s) for ${s.viewers} ${s.viewers === 1 ? 'person' : 'people'}.`
        : 'Nothing is sent until you add someone.';
    box.append(h('div', { class: 'callout' }, icon('i-lock'), h('span', { class: 'callout-text' },
      'Signed in as ', h('b', { text: s.account.name || s.account.email }), ` (${s.account.email}) on ${host}. ${what} Nothing on this computer accepts incoming connections.`,
      s.lastPushAt ? h('span', { class: 'callout-sub', text: `Last sent ${ago(s.lastPushAt)} · ${(s.lastBytes / 1024).toFixed(1)} KB` }) : null),
    h('button', { class: 'btn sm', type: 'button', text: 'Sign out', onclick: signOut })));
  }

  // ---------- shared with you (teammates' knowledge synced into this computer's skills) ----------
  function renderKnowledge(signedIn) {
    const k = status && status.knowledge;
    $('knowledge-box').hidden = !(signedIn && k && k.available);
    if ($('knowledge-box').hidden) return;
    $('knowledge-toggle').setAttribute('aria-checked', String(k.on));
    $('knowledge-word').textContent = k.on ? 'On' : 'Off';
    $('knowledge-sub').textContent = k.problem ? k.problem : k.on && k.lastSyncAt ? `Checked ${ago(k.lastSyncAt)}` : '';
    const u = k.usage || {};
    $('usage-perm').hidden = !(k.on && u.available);
    $('pool-perm').hidden = !k.on;
    $('pool-toggle').setAttribute('aria-checked', String(k.pool !== false));
    $('pool-word').textContent = k.pool !== false ? 'On' : 'Off';
    $('usage-toggle').setAttribute('aria-checked', String(!!u.on));
    $('usage-word').textContent = u.on ? 'On' : 'Off';
    // The same read-only skills for other agents on this computer, each with its own switch.
    const targets = $('knowledge-targets');
    targets.textContent = '';
    if (k.on) {
      for (const x of k.targets || []) {
        const label = `Also for ${x.label}`;
        targets.append(h('div', { class: 'perm' }, h('b', { text: label }),
          h('p', null, x.id === 'cursor' ? 'Adds them as Cursor rules in ' : 'Adds the same skills to ', h('code', { text: x.where }),
            x.detected ? ' (found on this computer). ' : ' (not found on this computer). ', 'Turning this off removes them there.'),
          h('div', { class: 'ctl' }, h('span', { text: x.on ? 'On' : 'Off' }),
            h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(x.on), 'aria-label': label, onclick: () => setTarget(x) }))));
      }
    }
    const body = $('knowledge');
    body.textContent = '';
    const asks = k.ask || [];
    $('knowledge-empty').hidden = k.decks.length + asks.length > 0;
    $('knowledge-table').hidden = !(k.decks.length + asks.length);
    // Teammates who answer questions: the teammate-ask skill tells the agent how, and that the
    // question (redacted) shows in their log.
    for (const a of asks) {
      body.append(h('tr', null,
        h('td', null, h('div', { class: 'who' }, h('span', { class: 'av', 'aria-hidden': 'true', text: initials(a.name) }), h('div', null, h('b', { text: a.name }), h('span', { text: `Until ${ends(a.expiresAt)}` })))),
        h('td', null, h('div', { class: 'scopes' }, h('span', { class: 'pill plain', title: 'Your agent asks with the teammate-ask skill; they see each question (redacted) in their log', text: 'Answers questions (they see each question)' }))),
        h('td', { class: 'muted', text: '' })));
    }
    for (const d of k.decks) {
      // Items the teammate has not updated or checked lately are flagged, as in the skill itself.
      const stale = `${d.name} has not checked this in over ${status.verifyDays || 30} days`;
      const pill = (text, isStale, dir) => h('span', { class: isStale ? 'pill tone-needs' : 'pill plain', title: isStale ? stale : dir || null, text: isStale ? `${text} (not checked lately)` : text });
      const pills = d.skills.map((x) => pill(x.title || x.dir, x.stale, x.dir));
      if (d.notes) pills.push(pill('Notes and memory', d.notesStale));
      body.append(h('tr', null,
        h('td', null, h('div', { class: 'who' }, h('span', { class: 'av', 'aria-hidden': 'true', text: initials(d.name) }), h('div', null, h('b', { text: d.name }), h('span', { text: `${d.skills.length} ${d.skills.length === 1 ? 'skill' : 'skills'}${d.notes ? ' and notes' : ''}` })))),
        h('td', null, h('div', { class: 'scopes' }, pills)),
        h('td', { class: 'muted', text: ago(d.syncedAt) })));
    }
  }

  async function setTarget(x) {
    try {
      status = (await post('/api/share/knowledge', { target: x.id, on: !x.on })).status;
      renderState();
      toast(x.on ? `Turned off. Teammate skills were removed from ${x.where}.` : `Knowledge shared with you will be added to ${x.where} within a minute.`);
    } catch (e) { toast(e.message, true); }
  }

  // ---------- people ----------
  function renderPeople() {
    const list = grants;
    $('people-count').textContent = String(list.length);
    $('people-empty').hidden = list.length > 0;
    $('people-table').hidden = !list.length;
    const body = $('people');
    body.textContent = '';
    for (const g of list) {
      const expired = g.expiresAt && g.expiresAt <= Date.now();
      body.append(h('tr', null,
        h('td', null, h('div', { class: 'who' }, h('span', { class: 'av', 'aria-hidden': 'true', text: initials(g.viewerName || g.viewerEmail) }),
          h('div', null, h('b', { text: g.viewerName || g.viewerEmail.split('@')[0] }), h('span', { text: g.viewerEmail }),
            g.hasAccount === false ? h('span', { class: 'tag', text: 'No account yet' }) : null))),
        h('td', null, h('div', { class: 'scopes' }, g.scopes.map((k) => h('span', { class: 'pill plain', text: (NAME[k] || k) + (k === 'notes' && g.notesTagged ? ' (marked Share)' : '') })))),
        h('td', { class: 'muted', text: g.projects.includes('*') ? 'All projects' : g.projects.join(', ') }),
        h('td', { class: expired ? 'denied' : null, text: ends(g.expiresAt) }),
        h('td', { class: g.lastViewed ? null : 'muted', text: ago(g.lastViewed) }),
        h('td', null, h('div', { class: 'btn-row end' },
          h('button', { class: 'btn sm', type: 'button', text: g.hasAccount ? 'Reset password' : 'Invite link', title: 'Create a one-time link (24 h) to send them yourself', onclick: () => invite(g.viewerEmail) }),
          h('button', { class: 'btn sm', type: 'button', text: expired ? 'Renew' : 'Edit', onclick: () => edit(g) }),
          h('button', { class: 'btn sm danger', type: 'button', text: 'Revoke', onclick: () => revoke(g.viewerEmail) })))));
    }
  }

  // ---------- what they can see ----------
  function permRow(s) {
    const on = chosen.has(s.key);
    // Notes: optionally only the ones marked Share under "Your skills and notes".
    // On the notes row, or on the questions row when notes are not shared.
    const only = on && (s.key === 'notes' || (s.key === 'ask' && !chosen.has('notes'))) ? h('label', { class: 'proj' }, h('input', { type: 'checkbox', checked: notesTagged, onchange: (e) => { notesTagged = e.target.checked; } }), 'Only notes marked Share') : null;
    return h('div', { class: 'perm' }, h('b', { text: s.name }), h('p', null, s.desc, only),
      h('div', { class: 'ctl' }, on ? 'On' : 'Off', h('button', {
        class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': s.name,
        onclick: () => { if (chosen.has(s.key)) chosen.delete(s.key); else chosen.add(s.key); renderWhat(); },
      })));
  }
  function renderWhat() {
    const left = $('perm-left');
    const right = $('perm-right');
    left.textContent = '';
    right.textContent = '';
    for (const s of SCOPES) (s.col ? right : left).append(permRow(s));
    for (const n of NEVER) right.append(h('div', { class: 'perm' }, h('b', { text: n.name }), h('p', { text: n.desc }), h('div', { class: 'ctl' }, h('span', { class: 'never' }, icon('i-lock'), n.word))));
    const names = (status && status.fleetProjects) || [];
    if (projects === null) projects = new Set(names);
    const box = $('proj-list');
    box.textContent = '';
    const all = projects.has('*');
    const check = (value, label) => h('label', { class: 'proj' }, h('input', {
      type: 'checkbox', value, checked: all || projects.has(value), disabled: all && value !== '*',
      onchange: (e) => { if (e.target.checked) projects.add(value); else projects.delete(value); renderWhat(); },
    }), label);
    box.append(check('*', 'All projects, including new ones'));
    for (const n of names) box.append(check(n, n));
    $('what-sub').textContent = editing ? `Editing access for ${editing}` : "For the person you add next; use Edit on a row to change someone's access";
  }
  const chosenProjects = () => (projects.has('*') ? ['*'] : [...projects]);

  // ---------- audit ----------
  function renderLog() {
    const body = $('log');
    body.textContent = '';
    $('log-empty').hidden = auditRows.length > 0;
    for (const r of auditRows.slice(0, 200)) {
      const refused = r.result === 'refused';
      const result = refused ? `Refused: ${r.reason || 'no access'}` : r.result ? r.result[0].toUpperCase() + r.result.slice(1) : '';
      body.append(h('tr', null, h('td', { text: r.ts ? when(r.ts) : '' }), h('td', { text: r.who || '' }), h('td', { text: r.what || '' }), h('td', { class: refused ? 'denied' : null, text: result })));
    }
  }
  // ---------- your skills and notes: freshness, verify, share/private ----------
  function renderItems() {
    const body = $('items');
    body.textContent = '';
    $('items-empty').hidden = items.length > 0;
    $('items-table').hidden = !items.length;
    $('items-sub').textContent = `Flagged when not updated or verified in ${status.verifyDays || 30} days`;
    for (const it of items) {
      const tag = it.kind === 'note' ? h('select', { class: 'input', 'aria-label': `Who gets ${it.title}`, onchange: (e) => setItem({ key: it.key, tag: e.target.value || null }) },
        [['', 'Every notes grant'], ['share', 'Share'], ['private', 'Private']].map(([v, label]) => h('option', { value: v, selected: (it.tag || '') === v, text: label }))) : h('span', { class: 'muted', text: 'Skills grants' });
      body.append(h('tr', null,
        h('td', null, h('b', { text: it.title }), it.stale ? h('span', { class: 'pill tone-needs', text: 'Not checked lately' }) : null),
        h('td', { class: 'muted', text: ago(it.updatedAt) }),
        h('td', { class: it.verifiedAt ? null : 'muted', text: ago(it.verifiedAt) }),
        h('td', null, tag),
        h('td', null, h('div', { class: 'btn-row end' },
          it.tag === 'private' ? null : h('button', { class: 'btn sm', type: 'button', text: 'Offer to team', title: 'An approver reviews it before it reaches the team', onclick: () => poolDo({ action: 'offer', key: it.key }, 'Offered. It reaches the team once an approver approves it.') }),
          h('button', { class: 'btn sm', type: 'button', text: 'Mark verified', onclick: () => setItem({ key: it.key, verified: true }) })))));
    }
  }
  async function loadItems() {
    try { items = (await get('/api/share/items')).items; renderItems(); } catch (e) { toast(e.message, true); }
  }
  async function setItem(change) {
    try {
      items = (await post('/api/share/item', change)).items;
      renderItems();
      toast(change.verified ? 'Marked verified. Teammates see the new date on their next sync.' : change.tag === 'private' ? 'Private: this note is no longer sent to anyone.' : 'Saved.');
    } catch (e) { toast(e.message, true); }
  }

  // ---------- team pool: offers wait for an approver, approved items reach every member ----------
  function renderPool() {
    const p = poolData;
    if (!p) return;
    const body = $('pool');
    body.textContent = '';
    $('pool-preview').hidden = true;
    const rows = [...p.pending.map((x) => ({ ...x, pending: true })), ...p.items];
    $('pool-empty').hidden = rows.length > 0;
    $('pool-table').hidden = !rows.length;
    $('pool-sub').textContent = p.approver ? 'You approve offers' : `Approved by ${p.approvers.join(', ') || 'the relay owner'}`;
    const btn = (text, onclick, cls) => h('button', { class: 'btn sm' + (cls ? ' ' + cls : ''), type: 'button', text, onclick });
    for (const x of rows) {
      const kind = x.kind === 'skill' ? 'Skill' : 'Note';
      const actions = x.pending
        ? [p.approver ? btn('Read', () => { const pre = $('pool-preview'); pre.textContent = x.text || ''; pre.hidden = false; pre.scrollIntoView({ block: 'nearest' }); }) : null,
          p.approver ? btn('Approve', () => poolDo({ action: 'approve', id: x.id }, `Approved. "${x.title}" reaches the team on their next sync.`)) : null,
          p.approver || x.mine ? btn(x.mine && !p.approver ? 'Withdraw' : 'Decline', () => poolDo({ action: 'decline', id: x.id }, 'Removed.'), 'danger') : null]
        : [p.approver ? btn('Remove', () => poolDo({ action: 'remove', id: x.id }, `Removed. It leaves everyone's agent on their next sync.`), 'danger') : null];
      body.append(h('tr', null,
        h('td', null, h('b', { text: x.title }), h('span', { class: 'muted', text: ` ${kind}` })),
        h('td', { text: x.by || '' }),
        h('td', { class: x.pending ? null : 'muted', text: x.pending ? 'Waiting for approval' : `Approved by ${x.approvedBy || ''} ${ago(x.approvedAt)}` }),
        h('td', null, h('div', { class: 'btn-row end' }, actions))));
    }
  }
  async function loadPool() {
    try { poolData = await get('/api/share/pool'); $('pool-box').hidden = false; renderPool(); } catch (e) { $('pool-box').hidden = true; }
  }
  async function poolDo(body, done) {
    try { poolData = (await post('/api/share/pool', body)).pool; $('pool-box').hidden = false; renderPool(); toast(done); } catch (e) { toast(e.message, true); }
  }

  // How often teammates' agents used what this captain shares (counts reported by their decks).
  function renderUsage() {
    const body = $('usage');
    body.textContent = '';
    $('usage-empty').hidden = usageRows.length > 0;
    $('usage-table').hidden = !usageRows.length;
    for (const r of usageRows.slice(0, 200)) {
      const name = r.key === 'notes' ? 'Your notes and memory' : r.title || r.key.split(':').pop();
      body.append(h('tr', null, h('td', { text: name }), h('td', { text: r.viewerEmail || '' }), h('td', { text: String(r.count) }), h('td', { text: String(r.cited || 0) }), h('td', { class: 'muted', text: ago(r.last) })));
    }
  }
  async function loadUsage() {
    try { usageRows = (await get('/api/share/usage')).rows; renderUsage(); } catch (e) { toast(e.message, true); }
  }
  function csv() {
    // Cells that start like a formula are quoted with a leading ' so spreadsheets show them as text.
    const cell = (v) => { let s = String(v === null || v === undefined ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const lines = [['When', 'Who', 'What', 'Result', 'Reason'].map(cell).join(',')];
    for (const r of auditRows) lines.push([r.ts ? new Date(r.ts).toISOString() : '', r.who, r.what, r.result, r.reason].map(cell).join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' })), download: 'ship-deck-audit.csv' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- actions ----------
  async function refresh() {
    try { status = await get('/api/share'); } catch (e) { status = status || null; return; }
    renderState();
    if (status.enabled && status.account && projects === null) renderWhat();
  }
  async function loadAll() {
    await refresh();
    if (!(status && status.enabled && status.account)) return;
    try { grants = (await get('/api/share/grants')).grants; renderPeople(); renderWhat(); } catch (e) { toast(e.message, true); }
    loadLog();
    loadUsage();
    loadItems();
    loadPool();
  }
  async function loadLog() {
    try { auditRows = (await get('/api/share/audit')).rows; renderLog(); } catch (e) { toast(e.message, true); }
  }
  async function signOut() {
    try { status = (await post('/api/share/signout')).status; renderState(); toast('Signed out. Nothing is sent from this computer.'); } catch (e) { toast(e.message, true); }
  }
  function edit(g) {
    editing = g.viewerEmail;
    chosen.clear();
    for (const k of g.scopes) chosen.add(k);
    projects = new Set(g.projects);
    notesTagged = !!g.notesTagged;
    $('add-email').value = g.viewerEmail;
    $('add-email').readOnly = true;
    $('add-label').textContent = 'Update access';
    $('add-cancel').hidden = false;
    renderWhat();
    $('what-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function stopEdit() {
    editing = null;
    notesTagged = false;
    $('add-email').readOnly = false;
    $('add-email').value = '';
    $('add-label').textContent = 'Give view access';
    $('add-cancel').hidden = true;
    renderWhat();
  }
  async function revoke(email) {
    try {
      grants = (await post('/api/share/revoke', { viewer: email })).grants;
      renderPeople();
      toast(`Revoked. ${email} can no longer see your deck.`);
      refresh();
      loadLog();
    } catch (e) { toast(e.message, true); }
  }
  async function invite(email) {
    try {
      const { invite: inv } = await post('/api/share/invite', { email });
      const out = $('invite-out');
      out.textContent = '';
      const field = h('input', { class: 'input', readonly: true, value: inv.link, 'aria-label': `Invite link for ${inv.email}` });
      out.append(h('p', { class: 'hint', text: `One-time link for ${inv.email}, valid until ${when(inv.expiresAt)}. Send it to them yourself (Slack or email); it lets them set a password.` }),
        h('div', { class: 'invite-link' }, field, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(inv.link); toast('Invite link copied'); } catch { field.select(); }
        } }, icon('i-copy'), 'Copy'), h('button', { class: 'btn ghost icon-btn sm', type: 'button', 'aria-label': 'Hide the invite link', onclick: () => { out.hidden = true; out.textContent = ''; } }, icon('i-x'))));
      out.hidden = false;
      field.select();
    } catch (e) { toast(e.message, true); }
  }

  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('signin-password');
    try {
      status = (await post('/api/share/signin', { email: $('signin-email').value, password: pw.value })).status;
      pw.value = '';
      toast('Signed in. Add a teammate to start sharing.');
      await loadAll();
    } catch (err) { pw.value = ''; toast(err.message, true); }
  });
  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('add-email').value.trim();
    try {
      const wasEditing = editing;
      grants = (await post('/api/share/grant', { email, scopes: [...chosen], projects: chosenProjects(), notesTagged, days: Number($('add-days').value) })).grants;
      stopEdit();
      renderPeople();
      const g = grants.find((x) => x.viewerEmail === email.toLowerCase());
      toast(wasEditing ? `Updated access for ${email}.` : `${email} can now view your deck.`);
      refresh();
      if (g && g.hasAccount === false) invite(g.viewerEmail);
      loadLog();
    } catch (err) { toast(err.message, true); }
  });
  $('add-cancel').addEventListener('click', stopEdit);
  $('share-toggle').addEventListener('click', async () => {
    try { status = (await post('/api/share/pause', { paused: !status.paused })).status; renderState(); } catch (e) { toast(e.message, true); }
  });
  $('preview-btn').addEventListener('click', async () => {
    const pre = $('preview');
    try {
      const q = new URLSearchParams({ scopes: [...chosen].join(','), projects: chosenProjects().join(',') });
      const d = await get('/api/share/preview?' + q);
      pre.textContent = JSON.stringify(d.snapshot, null, 2);
      pre.hidden = false;
      $('preview-size').textContent = `${(d.bytes / 1024).toFixed(1)} KB of 64 KB`;
    } catch (e) { toast(e.message, true); }
  });
  $('knowledge-toggle').addEventListener('click', async () => {
    const on = !(status.knowledge && status.knowledge.on);
    try {
      status = (await post('/api/share/knowledge', { on })).status;
      renderState();
      toast(on ? 'Knowledge shared with you will be added to your skills within a minute.' : 'Turned off. Teammate skills were removed from this computer.');
    } catch (e) { toast(e.message, true); }
  });
  $('log-refresh').addEventListener('click', loadLog);
  $('usage-refresh').addEventListener('click', loadUsage);
  $('pool-refresh').addEventListener('click', loadPool);
  $('pool-toggle').addEventListener('click', async () => {
    const on = !(status.knowledge && status.knowledge.pool !== false);
    try {
      status = (await post('/api/share/pool', { action: 'use', on })).status;
      renderState();
      toast(on ? 'Team pool items will be added to your skills within a minute.' : 'Turned off. Team pool skills were removed from this computer.');
    } catch (e) { toast(e.message, true); }
  });
  $('usage-toggle').addEventListener('click', async () => {
    const on = !(status.knowledge && status.knowledge.usage && status.knowledge.usage.on);
    try {
      status = (await post('/api/share/knowledge', { reportUsage: on })).status;
      renderState();
      toast(on ? 'Teammates will see how often your agent uses their skills (counts only).' : 'Turned off. No usage counts are sent.');
    } catch (e) { toast(e.message, true); }
  });
  $('log-csv').addEventListener('click', csv);

  loadAll();
  setInterval(refresh, 10000);
})();
