'use strict';
// The teammate's read-only view of a shared deck. Deck data is GET only from /v1/decks; the only
// writes are sign-in/out and the viewer's own agent keys. All deck text is set with textContent; redaction markers become grey chips.
// Polls at most every 30 s while the tab is visible, pauses after 10 idle minutes and backs off
// when the relay is over its free limit, so the free tiers are never pushed.

(function () {
  const B = window.ShipDeckBoard;
  const MD = window.ShipDeckMarkdown;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 30e3;
  const IDLE_MS = 10 * 60e3;
  const MAX_BACKOFF = 15 * 60e3;
  const DAY = 86400e3;
  const MARK_RE = /(\[(?:token|key|secret|path|link) hidden\])/;
  const SCOPE_NAME = { board: 'Board', updates: 'Updates', model: 'Model and effort', skills: 'Skills', terminal: 'Terminal output', notes: 'Notes and memory', chat: 'Chat and activity' };

  let viewer = null;
  let decks = [];
  let current = null; // captainSub
  let board = null;
  let project = null;
  let timer = null;
  let polls = 0;
  let backoff = 0;
  let lastInput = Date.now();
  let paused = false;
  let lastSig = '';
  let opener = null;

  // ---------- dom ----------
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
  function icon(id, cls) {
    const s = document.createElementNS(SVG_NS, 'svg');
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  }
  const flagEl = (f) => icon('flag-' + f, 'flag');
  // Text with "[path hidden]"-style markers shown as chips.
  function rtext(s) {
    const f = document.createDocumentFragment();
    String(s || '').split(MARK_RE).forEach((part, i) => {
      if (!part) return;
      f.append(i % 2 ? h('span', { class: 'redact', text: part.slice(1, -1) }) : document.createTextNode(part));
    });
    return f;
  }
  const first = (name) => String(name || 'Captain').split(' ')[0];
  const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} d`;
  }
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  // ---------- api ----------
  async function get(p) {
    let r;
    try { r = await fetch(p, { cache: 'no-store', credentials: 'same-origin' }); } catch { return { status: 0, data: {} }; }
    return { status: r.status, data: await r.json().catch(() => ({})), retryAfter: Number(r.headers.get('retry-after')) || 0 };
  }
  async function post(p, body, method = 'POST') {
    const r = await fetch(p, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => null);
    return { status: r ? r.status : 0, data: r ? await r.json().catch(() => ({})) : {} };
  }

  // ---------- views ----------
  function show(view) {
    $('signin').hidden = view !== 'signin';
    $('nodecks').hidden = view !== 'nodecks';
    $('deck').hidden = view !== 'deck';
    $('signout').hidden = view === 'signin';
    $('search-box').hidden = view !== 'deck';
    $('who').textContent = viewer ? `Signed in as ${viewer.email}` : 'Shared decks';
  }

  async function boot() {
    const r = await get('/v1/decks');
    if (r.status === 401) { viewer = null; show('signin'); return; }
    if (r.status !== 200) { retryLater(r); return; }
    viewer = r.data.viewer;
    decks = r.data.decks || [];
    const want = location.hash.slice(1);
    current = (decks.find((d) => d.captainSub === want) || decks[0] || {}).captainSub || null;
    if (!current) { show('nodecks'); return; }
    show('deck');
    renderAside();
    await loadBoard();
  }

  async function loadBoard() {
    clearTimeout(timer);
    const r = await get(`/v1/decks/${encodeURIComponent(current)}/board`);
    if (r.status === 401) { viewer = null; show('signin'); return; }
    const note = $('board-note');
    if (r.status === 403) {
      board = null;
      note.textContent = r.data.error === 'expired' ? 'Your access to this deck has ended. Ask its owner to renew it.' : 'This deck is no longer shared with you.';
      note.hidden = false;
      $('cols').textContent = '';
      return;
    }
    if (r.status !== 200) { retryLater(r); return; }
    backoff = 0;
    board = r.data;
    note.hidden = !board.offline;
    if (board.offline) note.textContent = `${possessive(first(board.captain.name))} deck is offline: no update in the last hour. You will see it again when their Ship Deck is running.`;
    renderBoard();
    renderAside();
    if (++polls % 60 === 0) refreshDecks(); // the deck list changes rarely: every 30 minutes
    schedule(POLL_MS);
  }
  async function refreshDecks() {
    const r = await get('/v1/decks');
    if (r.status === 200) { decks = r.data.decks || []; renderAside(); }
  }
  // Quota or outage: wait longer each time (up to 15 min) instead of retrying quickly.
  function retryLater(r) {
    backoff = Math.min(MAX_BACKOFF, Math.max((r.retryAfter || 0) * 1000, backoff ? backoff * 2 : 60e3));
    const note = $('board-note');
    note.textContent = r.data && r.data.error === 'quota'
      ? `The relay is over its free limit for now. Trying again in ${Math.round(backoff / 60e3)} min.`
      : `The relay is not answering. Trying again in ${Math.round(backoff / 60e3)} min.`;
    note.hidden = false;
    if (!$('deck').hidden || current) show('deck');
    timer = setTimeout(current ? loadBoard : boot, backoff);
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (document.hidden) return; // resumes on visibilitychange
    if (Date.now() - lastInput > IDLE_MS) { paused = true; renderAge(); return; }
    timer = setTimeout(loadBoard, ms);
  }
  function wake() {
    lastInput = Date.now();
    if (paused && current && !document.hidden) { paused = false; loadBoard(); }
  }
  ['pointerdown', 'keydown', 'scroll'].forEach((ev) => addEventListener(ev, wake, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current && board !== undefined) { lastInput = Date.now(); paused = false; loadBoard(); } });

  function renderAge() {
    const el = $('vb-age');
    if (!board) { el.textContent = ''; return; }
    el.textContent = paused ? 'Paused while you are away; click to refresh'
      : board.offline ? 'Offline' : `Last update ${ago(board.at)} ago; sent when something changes`;
  }
  setInterval(renderAge, 5000);

  function workerStatus(w) {
    const t = { state: w.state, stale: w.quietDays !== null && w.quietDays !== undefined, lastActivity: w.quietDays ? Date.now() - w.quietDays * DAY : null };
    const st = B.statusOf(t);
    if (w.state === 'needs-decision') st.label = `Waiting on ${first(board.captain.name)}`;
    return { st, col: B.columnOf(t) === 'quiet' ? 'waiting' : B.columnOf(t) };
  }
  const pill = (st) => h('span', { class: `pill tone-${st.tone}` }, flagEl(st.flag), st.label);

  function matches(w) {
    const q = $('search').value.trim().toLowerCase();
    if (project && String(w.project || '').toLowerCase() !== project.toLowerCase()) return false;
    return !q || [w.title, w.id, w.project, w.summary].some((x) => String(x || '').toLowerCase().includes(q));
  }

  function card(w) {
    const { st } = workerStatus(w);
    const tool = [w.model && w.model !== 'default' ? w.model : null, w.effort && w.effort !== 'auto' ? w.effort : null].filter(Boolean).join(' · ');
    return h('article', { class: `bcard tone-${st.tone}${st.tone === 'needs' ? ' hoist' : ''}` },
      h('div', { class: 'card-top' }, pill(st), h('span', { class: 'age', text: ago(w.updatedAt) })),
      h('h3', { class: 'card-title' }, h('button', { class: 'card-link', type: 'button', onclick: (e) => openWorker(w, e.currentTarget) }, rtext(w.title))),
      h('div', { class: 'card-meta' }, h('code', { text: w.id || '' }), w.project ? h('span', { text: w.project }) : null),
      w.summary ? h('p', { class: 'card-summary' }, rtext(w.summary)) : null,
      (w.options || []).map((o) => h('div', { class: 'opt-ro' }, h('b', { text: o.letter }), rtext(o.text))),
      h('div', { class: 'card-foot' }, prChip(w.pr), tool ? h('span', { class: 'tool', text: tool }) : null));
  }
  function prChip(pr) {
    if (!pr || !pr.number) return null;
    const kids = [icon('i-pr'), `#${pr.number}`];
    return pr.url ? h('a', { class: 'chip', href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, ...kids) : h('span', { class: 'chip' }, ...kids);
  }

  function renderBoard() {
    const name = board.captain.name;
    $('vb-name').textContent = possessive(name);
    $('board-title').textContent = `${possessive(first(name))} work`;
    const f = board.fleet || {};
    $('vb-health').textContent = [f.firstMate ? `First mate ${f.firstMate.state === 'working' ? 'working' : 'idle'}` : null, f.monitoring === 'ok' ? 'Monitoring on' : 'Monitoring late'].filter(Boolean).join(' · ');
    renderAge();
    const workers = board.workers || [];
    const names = [...new Set(workers.map((w) => w.project).filter(Boolean))].sort();
    const filters = $('filters');
    filters.textContent = '';
    if (names.length > 1) {
      for (const n of [null, ...names]) {
        filters.append(h('button', { class: 'filter', type: 'button', 'aria-pressed': String(project === n), text: n || 'All', onclick: () => { project = n; lastSig = ''; renderBoard(); } }));
      }
    }
    $('hidden-note').textContent = board.hiddenProjects ? `${board.hiddenProjects} private project${board.hiddenProjects === 1 ? '' : 's'} hidden` : '';
    const sig = JSON.stringify([workers, project, $('search').value]);
    if (sig === lastSig) return;
    lastSig = sig;
    const cols = $('cols');
    cols.textContent = '';
    for (const c of B.COLUMNS) {
      const list = workers.filter((w) => matches(w) && workerStatus(w).col === c.key);
      cols.append(h('div', { class: 'col' },
        h('div', { class: 'col-head' }, flagEl(c.flag), h('h2', { text: c.key === 'needs' ? `Needs ${first(name)}` : c.title }), h('span', { class: 'count' + (c.key === 'needs' && list.length ? ' needs' : ''), text: String(list.length) })),
        h('div', { class: 'col-body' }, list.length ? list.map(card) : h('p', { class: 'empty', text: 'Nothing here' }))));
    }
  }

  function renderAside() {
    const d = decks.find((x) => x.captainSub === current);
    const g = (board && board.grant) || (d && d.grant);
    const name = (board && board.captain.name) || (d && d.name) || 'Captain';
    $('aside-title').textContent = `${first(name)} shares with you`;
    $('aside-until').textContent = g ? `Until ${fmtDate(g.expiresAt)}. ${first(name)} can see that you viewed.` : '';
    const list = $('aside-scopes');
    list.textContent = '';
    if (g) {
      const has = (k) => g.scopes.includes(k);
      const rows = [
        [has('board'), has('updates') ? 'Board and updates' : 'Board'],
        [has('model'), 'Model and effort'],
        [has('skills'), 'Skills, which your agent can use'],
        [has('terminal'), 'Terminal output, redacted'],
        [has('notes'), 'Notes and memory'],
        [has('chat'), 'Chat and activity'],
      ];
      for (const [yes, text] of rows) list.append(h('li', { class: yes ? 'yes' : 'no' }, icon(yes ? 'i-check' : 'i-dash'), text));
      list.append(h('li', { class: 'no' }, icon('i-lock'), 'Attachments, paths, sessions'));
      const extras = $('aside-extras');
      extras.textContent = '';
      for (const [k, ic] of [['skills', 'i-book'], ['notes', 'i-book'], ['chat', 'i-chat']]) {
        if (has(k)) extras.append(h('button', { class: 'btn sm', type: 'button', onclick: (e) => openScope(k, e.currentTarget) }, icon(ic), SCOPE_NAME[k]));
      }
      // Ship Deck syncs skills and notes into the viewer's agent on its own; keys are for agents without it.
      if (has('skills') || has('notes')) extras.append(h('button', { class: 'btn sm', type: 'button', onclick: (e) => openKeys(e.currentTarget) }, icon('i-lock'), 'Agent keys'));
    }
    $('aside-ask').textContent = `You can look but not act. To ask ${first(name)} something, message them directly.`;
    const box = $('decks');
    box.textContent = '';
    for (const x of decks) {
      const sub = x.offline ? 'Offline' : `${x.workers === null ? '' : `${x.workers} workers, `}updated ${ago(x.at)} ago`;
      box.append(h('a', { class: 'deck-link', href: '#' + x.captainSub, 'aria-current': x.captainSub === current ? 'page' : null, onclick: (e) => { e.preventDefault(); switchDeck(x.captainSub); } },
        h('span', { class: 'av', 'aria-hidden': 'true', text: String(x.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() }),
        h('div', null, x.name || x.email, h('span', { text: sub }))));
    }
  }
  function switchDeck(sub) {
    if (sub === current) return;
    current = sub;
    board = null;
    project = null;
    lastSig = '';
    history.replaceState(null, '', '#' + sub);
    renderAside();
    loadBoard();
  }

  // ---------- sheet: one worker, or skills / notes / chat ----------
  function openSheet(title, from) {
    opener = from || null;
    $('sheet-title').textContent = title;
    $('sheet-body').textContent = '';
    $('sheet').hidden = false;
    $('sheet-scrim').hidden = false;
    $('sheet').focus();
    return $('sheet-body');
  }
  function closeSheet() {
    $('sheet').hidden = true;
    $('sheet-scrim').hidden = true;
    if (opener) opener.focus();
  }
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-scrim').addEventListener('click', closeSheet);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

  async function scope(k, ref) {
    const r = await get(`/v1/decks/${encodeURIComponent(current)}/${k}${ref ? '?ref=' + encodeURIComponent(ref) : ''}`);
    return r.status === 200 ? r.data : null;
  }
  async function openWorker(w, from) {
    const body = openSheet(w.title, from);
    const { st } = workerStatus(w);
    body.append(h('div', { class: 'card-top' }, pill(st), w.project ? h('span', { class: 'muted', text: w.project }) : null, prChip(w.pr)));
    if (w.summary) body.append(h('p', { class: 'card-summary' }, rtext(w.summary)));
    for (const o of w.options || []) body.append(h('div', { class: 'opt-ro' }, h('b', { text: o.letter }), rtext(o.text)));
    const g = board.grant;
    if (g.scopes.includes('updates')) {
      const d = await scope('updates', w.ref);
      const list = (d && d.updates && d.updates[w.ref]) || [];
      body.append(h('section', null, h('h3', { text: 'Updates' }), list.length
        ? h('ul', { class: 'v-list' }, list.slice().reverse().map((u) => h('li', null, h('span', { class: 'when', text: [u.ts, B.statusOf({ state: u.state }).label].filter(Boolean).join(' · ') }), h('span', null, rtext(u.note)))))
        : h('p', { class: 'empty', text: 'No updates yet' })));
    }
    if (g.scopes.includes('terminal')) {
      const d = await scope('terminal', w.ref);
      const t = d && d.terminal && d.terminal[w.ref];
      body.append(h('section', null, h('h3', { text: 'Terminal (last 40 lines, redacted)' }), t
        ? h('div', { class: 'term' }, h('pre', { class: 'peek wrap', tabindex: '0' }, rtext(t.lines.join('\n'))), h('div', { class: 'term-foot', text: `Captured ${ago(t.at)} ago` }))
        : h('p', { class: 'empty', text: 'No terminal for this worker right now' })));
    }
  }
  async function openScope(k, from) {
    const body = openSheet(SCOPE_NAME[k], from);
    const d = await scope(k);
    if (!d) { body.append(h('p', { class: 'empty', text: 'Not available right now' })); return; }
    if (k === 'skills') {
      body.append(h('ul', { class: 'v-list' }, (d.skills || []).map((s) => h('li', null, h('b', null, rtext(s.title)), h('span', { class: 'muted' }, rtext(s.description))))));
    } else if (k === 'notes') {
      for (const n of d.notes || []) {
        const md = h('div', { class: 'md' });
        md.innerHTML = MD.render(n.text || '', { frontmatter: 'show' }); // escaped by the renderer
        const cut = n.shortened ? h('p', { class: 'hint', text: 'Shortened to fit. Your agent gets the full note through Ship Deck.' }) : null;
        body.append(h('section', null, h('h3', null, rtext(n.title)), md, cut));
      }
    } else if (k === 'chat') {
      body.append(h('section', null, h('h3', { text: 'Chat' }), h('ul', { class: 'v-list' }, (d.chat || []).map((c) => h('li', null, h('span', { class: 'when', text: `${c.from === 'firstmate' ? 'First mate' : first(board.captain.name)}${c.ts ? ' · ' + c.ts : ''}` }), h('span', null, rtext(c.text)))))));
      body.append(h('section', null, h('h3', { text: 'Activity' }), h('ul', { class: 'v-list' }, (d.activity || []).slice().reverse().map((a) => h('li', null, h('span', { class: 'when', text: a.ts ? new Date(a.ts).toLocaleTimeString() : '' }), h('span', null, rtext(a.label)))))));
    }
  }

  // ---------- agent keys: read-only keys for the viewer's own AI agent ----------
  // A new key is shown once and never again; the relay keeps only its hash.
  async function openKeys(from) {
    const body = openSheet('Agent keys', from);
    const deck = current;
    const name = first((board && board.captain.name) || (decks.find((x) => x.captainSub === deck) || {}).name);
    const r = await get(`/v1/decks/${encodeURIComponent(deck)}/agent-keys`);
    if (r.status !== 200) { body.append(h('p', { class: 'empty', text: r.status === 403 ? `${name} does not share skills or notes with you.` : 'Not available right now' })); return; }
    renderKeys(body, deck, name, r.data, null);
  }
  function renderKeys(body, deck, name, d, fresh) {
    body.textContent = '';
    const what = d.skills && d.notes ? 'skills, notes and memory' : d.notes ? 'notes and memory' : 'skills';
    body.append(h('p', { class: 'fine', text: `Your own Ship Deck already gives your agent ${possessive(name)} ${what}: sign in under Settings > Sharing and keep "Use knowledge shared with me" on. You need a key only for an agent that runs without Ship Deck.` }));
    body.append(h('p', { class: 'fine', text: `A key lets that agent read them, read only, up to ${d.perHour} times an hour. Every read shows in ${possessive(name)} log. Keys end when your access ends.` }));
    if (fresh) {
      const field = h('input', { class: 'input', readonly: true, value: fresh.token, 'aria-label': `Agent key ${fresh.key.label}` });
      body.append(h('section', { class: 'invite-out' },
        h('p', { class: 'hint', text: 'Copy this key now: it is shown only once. Put it in SHIP_DECK_LIBRARY_KEY for your agent (see docs/AGENT-LIBRARY.md).' }),
        h('div', { class: 'invite-link' }, field, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(fresh.token); } catch { field.select(); }
        } }, icon('i-copy'), 'Copy'))));
    }
    const list = h('ul', { class: 'v-list' }, d.keys.map((k) => h('li', null,
      h('b', { text: k.label }),
      h('span', { class: 'muted', text: `Made ${fmtDate(k.createdAt)} · ${k.lastUsed ? `last used ${ago(k.lastUsed)} ago` : 'never used'} · ends ${fmtDate(k.expiresAt)}` }),
      h('div', null, h('button', { class: 'btn sm danger', type: 'button', text: 'Revoke', onclick: async () => {
        const res = await post(`/v1/decks/${encodeURIComponent(deck)}/agent-keys/${encodeURIComponent(k.id)}`, undefined, 'DELETE');
        if (res.status !== 200) return;
        const again = await get(`/v1/decks/${encodeURIComponent(deck)}/agent-keys`);
        if (again.status === 200) renderKeys(body, deck, name, again.data, null);
      } })))));
    body.append(h('section', null, h('h3', { text: `Your keys (${d.keys.length} of ${d.max})` }), d.keys.length ? list : h('p', { class: 'empty', text: 'No keys yet' })));
    if (d.keys.length < d.max) {
      const label = h('input', { class: 'input', maxlength: '40', placeholder: 'Label, e.g. work laptop', 'aria-label': 'Key label' });
      const err = h('p', { class: 'v-error', role: 'alert', hidden: true });
      const form = h('form', { class: 'invite-link' }, label, h('button', { class: 'btn sm primary', type: 'submit', text: 'Create agent key' }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await post(`/v1/decks/${encodeURIComponent(deck)}/agent-keys`, { label: label.value });
        if (res.status !== 200) { err.textContent = res.data.error || 'The relay could not be reached.'; err.hidden = false; return; }
        renderKeys(body, deck, name, res.data, { token: res.data.token, key: res.data.key });
      });
      body.append(h('section', null, form, err));
    }
    body.append(h('p', { class: 'fine' }, 'Endpoint: ', h('code', { text: d.endpoint })));
  }

  // ---------- sign in / out ----------
  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('signin-password');
    const r = await post('/api/auth/login', { email: $('signin-email').value, password: pw.value });
    pw.value = '';
    const err = $('signin-error');
    if (r.status !== 200) { err.textContent = r.data.error || 'The relay could not be reached.'; err.hidden = false; return; }
    err.hidden = true;
    boot();
  });
  $('signout').addEventListener('click', async () => {
    await post('/api/auth/logout');
    clearTimeout(timer);
    viewer = null;
    current = null;
    board = null;
    show('signin');
  });
  $('search').addEventListener('input', () => { if (board) renderBoard(); });

  boot();
})();
