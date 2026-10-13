'use strict';
// Ship Deck frontend: polls /api/fleet, reconciles the deck in place, and runs
// the captain's control surface (Bridge chat, orders, sessions, library).

(() => {
  const POLL_MS = 3000;
  const STATE_ORDER = ['needs-decision', 'blocked', 'failed', 'working', 'paused', 'unknown', 'done'];
  const COUNT_ORDER = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'stale'];
  const ATTENTION = new Set(['needs-decision', 'blocked', 'failed']);
  const STATE_LABEL = {
    'working': 'working', 'needs-decision': 'decision', 'blocked': 'blocked', 'paused': 'paused',
    'done': 'done', 'failed': 'failed', 'unknown': 'no status', 'resolved': 'resolved', 'stale': 'stale',
  };
  const MAX_CRATES = 48;
  const MD = window.ShipDeckMarkdown;

  const $ = (id) => document.getElementById(id);
  const ui = {
    home: $('home-path'), search: $('search'), sync: $('sync'), syncText: $('sync-text'),
    reconnect: $('reconnect'), reconnectText: $('reconnect-text'), reconnectNow: $('reconnect-now'),
    captain: $('captain'), firstmate: $('firstmate'), awaySign: $('away-sign'), lamp: $('lamp'), lampLabel: $('lamp-label'), wheel: $('wheel'),
    areas: $('areas'), cabins: $('cabins'), cabinRow: $('cabin-row'),
    hold: $('hold'), holdSub: $('hold-sub'), crates: $('crates'),
    tabs: { bridge: $('tab-bridge'), command: $('tab-command'), activity: $('tab-activity'), sessions: $('tab-sessions') },
    panes: { bridge: $('pane-bridge'), command: $('pane-command'), activity: $('pane-activity'), sessions: $('pane-sessions') },
    layout: document.querySelector('.layout'), panel: $('panel'), panelResize: $('panel-resize'),
    feed: $('feed'), activityState: $('activity-state'), activitySub: $('activity-sub'), activityDot: $('activity-dot'),
    ticker: $('ticker'), tickerIcon: $('ticker-icon'), tickerText: $('ticker-text'), tickerAge: $('ticker-age'), fmPill: $('fm-pill'),
    unread: $('unread-count'), needsTab: $('needs-tab-count'),
    thread: $('thread'), threadJump: $('thread-jump'), chatForm: $('chat-form'), chatText: $('chat-text'), chatSend: $('chat-send'),
    notifyBtn: $('notify-btn'), bridgeSub: $('bridge-sub'), chatHint: $('chat-hint'),
    attTray: $('att-tray'), attachBtn: $('attach-btn'), attachInput: $('attach-input'),
    lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxCap: $('lightbox-cap'), lightboxClose: $('lightbox-close'),
    watch: $('watch-card'), counts: $('counts'),
    needsCount: $('needs-count'), needsList: $('needs-list'),
    callsCount: $('calls-count'), callsList: $('calls-list'),
    queuedCount: $('queued-count'), queuedList: $('queued-list'),
    jobForm: $('job-form'), jobProject: $('job-project'), jobText: $('job-text'), newJob: $('new-job'),
    jobHarness: $('job-harness'), jobModel: $('job-model'), jobEffort: $('job-effort'),
    doneList: $('done-list'), cleanupDone: $('cleanup-done'), prList: $('pr-list'),
    ordersCount: $('orders-count'), ordersList: $('orders-list'),
    sessionsList: $('sessions-list'), sessionsFilter: $('sessions-filter'),
    drawer: $('drawer'), scrim: $('scrim'), drawerKicker: $('drawer-kicker'), drawerTitle: $('drawer-title'),
    drawerBody: $('drawer-body'), drawerClose: $('drawer-close'),
    libraryBtn: $('library-btn'), library: $('library'), libraryScrim: $('library-scrim'), libraryClose: $('library-close'),
    libraryFilter: $('library-filter'), libraryList: $('library-list'), libraryDoc: $('library-doc'),
    confirm: $('confirm'), confirmScrim: $('confirm-scrim'), confirmTitle: $('confirm-title'), confirmBody: $('confirm-body'),
    confirmWarn: $('confirm-warn'), confirmYes: $('confirm-yes'), confirmNo: $('confirm-no'),
    toasts: $('toasts'),
  };

  let snap = null;
  let query = '';
  let stateFilter = null;
  let selected = null; // { type: 'task' | 'backlog' | 'secondmate' | 'firstmate', id }
  let lastOkAt = 0;
  const stations = new Map(); // id -> element
  const areaEls = new Map(); // projectKey -> { root, plaque, tally, grid }
  let firstRender = true;

  // Per-viewer state in localStorage; every access tolerates a blocked store.
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem('shipdeck.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { if (v === null || v === undefined || v === '') localStorage.removeItem('shipdeck.' + k); else localStorage.setItem('shipdeck.' + k, String(v)); } catch { /* ignore */ } },
    json(k, d) { try { return JSON.parse(this.get(k, 'null')) ?? d; } catch { return d; } },
  };
  // Restores a field's draft and saves it on every edit; clearDraft after a successful send.
  function persist(el, key) {
    el.dataset.draft = key;
    const saved = store.get('draft.' + key);
    if (saved !== null && !el.value) el.value = saved;
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => store.set('draft.' + key, el.value));
    return el;
  }
  function clearDraft(el) { el.value = ''; store.set('draft.' + el.dataset.draft, null); }

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'style') el.style.cssText = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function hash(s) {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
    return x >>> 0;
  }
  function ago(ms) {
    if (!ms) return '—';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  function agoLong(ms) {
    if (!ms) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function stamp(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function stateVar(state) { return `var(--s-${state || 'unknown'})`; }
  function prNumber(url) { const m = /\/pull\/(\d+)/.exec(url || ''); return m ? '#' + m[1] : 'PR'; }
  // Skips a DOM rebuild when its inputs are unchanged, so focus and hover survive polling.
  const sigs = new Map();
  function unchanged(name, ...parts) {
    const sig = JSON.stringify(parts);
    if (sigs.get(name) === sig) return true;
    sigs.set(name, sig);
    return false;
  }
  // Stale crew are bucketed as "stale" for counts, tallies and the state filter.
  function bucket(t) { return t.stale ? 'stale' : t.state; }
  function staleText(t) { return `no activity for ${agoLong(t.lastActivity).replace(' ago', '')} (stale after ${snap.staleDays} d)`; }
  function lastNote(t) { const l = t.lastStatus[t.lastStatus.length - 1]; return l ? l.note : ''; }

  const SAILOR = `
    <g class="body">
      <rect class="legs" x="13" y="37" width="14" height="10" rx="2"/>
      <path class="torso" d="M12 21h16a3 3 0 0 1 3 3v15H9V24a3 3 0 0 1 3-3z"/>
      <path class="stripes" clip-path="url(#torso-clip)" d="M8 26.5h24M8 31h24M8 35.5h24"/>
      <g class="arm arm-l"><rect class="torso" x="7" y="22" width="5" height="10" rx="2.5"/><circle class="skin" cx="9.5" cy="33" r="2.3"/></g>
      <g class="arm arm-r"><rect class="torso" x="28" y="22" width="5" height="10" rx="2.5"/><circle class="skin" cx="30.5" cy="33" r="2.3"/><path class="tool" d="M30.5 33.5L35 42"/></g>
      <circle class="skin" cx="20" cy="14.5" r="6.5"/>
      <circle class="eye" cx="17.7" cy="15" r="0.95"/><circle class="eye" cx="22.3" cy="15" r="0.95"/>
      <path class="cap" d="M12.6 11.2C13 6.5 16.2 4.6 20 4.6s7 1.9 7.4 6.6z"/>
      <rect class="cap-band" x="12.4" y="10.2" width="15.2" height="2.2" rx="1.1"/>
    </g>`;
  const FLAG = '<path class="pole" d="M3 1v39"/><path class="cloth" d="M3.8 2.5h15.5l-4.5 6 4.5 6H3.8z"/>';
  const BELL = '<path fill="currentColor" d="M8 1.5a1 1 0 0 1 1 1v.6a4.5 4.5 0 0 1 3.5 4.4v3l1.3 1.8a.6.6 0 0 1-.5 1H2.7a.6.6 0 0 1-.5-1L3.5 10.5v-3A4.5 4.5 0 0 1 7 3.1v-.6a1 1 0 0 1 1-1zM6.3 13.6h3.4a1.7 1.7 0 0 1-3.4 0z"/>';
  const CHEST = '<rect class="box" x="1" y="6" width="20" height="11" rx="1.5"/><path class="box" d="M1 7.5C1 3 4 2 11 2s10 1 10 5.5z"/><path class="tick" d="M7.5 11.5l2.6 2.6 4.6-5"/>';
  const XMARK = '<path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>';
  const svg = (cls, vb, inner) => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true">${inner}</svg>`;

  document.querySelectorAll('.officer .sailor').forEach((s) => { s.innerHTML = SAILOR; });

  // ---------- filtering ----------
  function matchesTask(t) {
    if (stateFilter && bucket(t) !== stateFilter) return false;
    if (!query) return true;
    const hay = [t.id, t.project, t.state, STATE_LABEL[t.state], t.stale && 'stale', t.kind, t.mode, t.brief].join(' ').toLowerCase();
    return query.split(/\s+/).every((q) => hay.includes(q));
  }
  function matchesCrate(item) {
    if (stateFilter) return false;
    if (!query) return true;
    const hay = [item.id, item.title, item.tags && item.tags.repo, 'queued backlog'].join(' ').toLowerCase();
    return query.split(/\s+/).every((q) => hay.includes(q));
  }

  // ---------- stations ----------
  function makeStation(t) {
    const el = h('button', { class: 'station', type: 'button', 'data-id': t.id });
    el.style.setProperty('--d', `-${(hash(t.id) % 1100) / 1000}s`);
    el.innerHTML =
      '<div class="post">' +
        svg('flag', '0 0 22 40', FLAG) +
        `<svg class="sailor" viewBox="0 0 40 48" aria-hidden="true">${SAILOR}</svg>` +
        svg('chest', '0 0 22 18', CHEST) +
        svg('bell', '0 0 16 16', BELL) +
        svg('xmark', '0 0 16 16', XMARK) +
        '<span class="zz">z</span><span class="zz">z</span>' +
        '<span class="alive"></span>' +
      '</div>' +
      '<span class="stale-tag">stale</span>' +
      '<div class="label"><span class="id"></span><span class="sub"><span class="pill"></span><span class="age"></span></span></div>';
    el.addEventListener('click', () => openDrawer({ type: 'task', id: t.id }));
    return el;
  }
  function updateStation(el, t) {
    const prev = el.dataset.state;
    for (const c of [...el.classList]) if (c.startsWith('st-') || c.startsWith('k-')) el.classList.remove(c);
    el.classList.add('st-' + t.state, 'k-' + t.kind);
    el.classList.toggle('is-alive', t.alive === true);
    el.classList.toggle('is-stale', !!t.stale);
    el.classList.toggle('selected', !!selected && selected.type === 'task' && selected.id === t.id);
    el.dataset.state = t.state;
    if (prev && prev !== t.state) {
      el.classList.remove('changed');
      void el.offsetWidth;
      el.classList.add('changed');
      setTimeout(() => el.classList.remove('changed'), 1700);
    }
    el.querySelector('.id').textContent = t.id;
    el.querySelector('.pill').textContent = STATE_LABEL[t.state] || t.state;
    el.querySelector('.age').textContent = ago(t.lastActivity);
    const alive = t.alive === true ? 'window open' : t.alive === false ? 'window closed' : '';
    el.title = `${t.id}\n${t.project} · ${t.kind}${t.mode ? ' · ' + t.mode : ''}\n${STATE_LABEL[t.state]}${alive ? ' · ' + alive : ''}` +
      `${t.stale ? '\nSTALE: ' + staleText(t) : ''}\n\n${lastNote(t).slice(0, 220)}`;
    el.setAttribute('aria-label', `${t.id}, ${t.project}, ${STATE_LABEL[t.state]}${t.stale ? ', stale' : ''}`);
  }

  // Stale crew sit after the active crew and before the done crew.
  function rank(t) { return t.stale ? STATE_ORDER.indexOf('done') - 0.5 : STATE_ORDER.indexOf(t.state); }
  function sortTasks(a, b) {
    const d = rank(a) - rank(b);
    return d || a.id.localeCompare(b.id);
  }

  function makeArea(key) {
    const plaque = h('h2', { class: 'plaque' });
    const tally = h('div', { class: 'area-tally' });
    const grid = h('div', { class: 'stations' });
    const root = h('section', { class: 'area', 'data-area': key }, h('div', { class: 'area-head' }, plaque, tally), grid);
    return { root, plaque, tally, grid };
  }

  function renderDeck() {
    const crew = snap.tasks.filter((t) => t.kind !== 'secondmate');
    const byArea = new Map();
    for (const t of crew) {
      if (!byArea.has(t.projectKey)) byArea.set(t.projectKey, []);
      byArea.get(t.projectKey).push(t);
    }
    const areaKeys = [...byArea.keys()].sort((a, b) => byArea.get(b).length - byArea.get(a).length || a.localeCompare(b));
    const regMode = new Map(snap.projects.map((p) => [p.name.toLowerCase(), p]));

    // FLIP: remember where everyone stood.
    const before = new Map();
    if (!firstRender) for (const [id, el] of stations) if (el.isConnected) before.set(id, el.getBoundingClientRect());

    const seen = new Set();
    for (const key of areaKeys) {
      let area = areaEls.get(key);
      if (!area) { area = makeArea(key); areaEls.set(key, area); }
      const tasks = byArea.get(key).sort(sortTasks);
      const reg = regMode.get(key);
      area.plaque.replaceChildren(...[tasks[0].project, reg && reg.mode ? h('span', { class: 'plaque-sub', text: reg.mode }) : null].filter(Boolean));
      if (reg && reg.description) area.plaque.title = reg.description;
      const tallies = {};
      for (const t of tasks) tallies[bucket(t)] = (tallies[bucket(t)] || 0) + 1;
      area.tally.replaceChildren(...[...STATE_ORDER, 'stale'].filter((s) => tallies[s]).map((s) =>
        h('span', { class: 'tally', title: STATE_LABEL[s] }, h('i', { style: `background:${stateVar(s)}` }), tallies[s])));
      let visible = 0;
      tasks.forEach((t) => {
        seen.add(t.id);
        let el = stations.get(t.id);
        const isNew = !el;
        if (isNew) { el = makeStation(t); stations.set(t.id, el); }
        updateStation(el, t);
        if (isNew && !firstRender) { el.classList.add('boarding'); setTimeout(() => el.classList.remove('boarding'), 800); }
        el.classList.remove('leaving');
        const show = matchesTask(t);
        el.classList.toggle('hidden-by-filter', !show);
        if (show) visible++;
        area.grid.append(el); // append re-orders in place
      });
      area.root.classList.toggle('hidden-by-filter', visible === 0);
      ui.areas.append(area.root);
    }
    for (const [key, area] of areaEls) {
      if (!byArea.has(key)) { area.root.remove(); areaEls.delete(key); }
    }
    for (const [id, el] of stations) {
      if (seen.has(id)) continue;
      stations.delete(id);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 650);
    }
    if (!crew.length && !ui.areas.querySelector('.empty-deck')) {
      ui.areas.append(h('p', { class: 'empty-deck', text: 'The deck is quiet. No tasks in flight.' }));
    } else if (crew.length) {
      ui.areas.querySelectorAll('.empty-deck').forEach((e) => e.remove());
    }

    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const [id, r0] of before) {
        const el = stations.get(id);
        if (!el || !el.isConnected || el.classList.contains('hidden-by-filter')) continue;
        const r1 = el.getBoundingClientRect();
        const dx = r0.left - r1.left;
        const dy = r0.top - r1.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
            { duration: 550, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      }
    }
    document.body.classList.toggle('has-tmux', !!snap.tmux.available);
  }

  // ---------- cabins ----------
  function renderCabins() {
    const metas = snap.tasks.filter((t) => t.kind === 'secondmate');
    const reg = snap.secondmates.registry || [];
    const ids = new Set(metas.map((t) => t.id));
    const vacant = reg.filter((r) => !ids.has(r.id));
    ui.cabins.hidden = !metas.length && !vacant.length;
    if (ui.cabins.hidden) return;
    if (unchanged('cabins', metas.map((t) => [t.id, t.state, t.stale, ago(t.lastActivity), matchesTask(t)]), vacant)) return;
    const cabin = (id, sub, cls, onclick) => h('button', { class: 'cabin ' + cls, type: 'button', onclick },
      h('span', { class: 'porthole' }),
      h('div', null, h('div', { class: 'cab-id', text: id }), h('div', { class: 'cab-sub', text: sub })));
    const kids = [];
    for (const t of metas.sort(sortTasks)) {
      const c = cabin(t.id, `${STATE_LABEL[t.state]}${t.stale ? ' · stale' : ''} · ${ago(t.lastActivity)}`,
        `k-secondmate st-${t.state}${t.stale ? ' is-stale' : ''}`, () => openDrawer({ type: 'task', id: t.id }));
      c.style.setProperty('--c', stateVar(bucket(t)));
      c.classList.toggle('hidden-by-filter', !matchesTask(t));
      c.querySelector('.porthole').innerHTML = `<svg class="sailor" viewBox="0 0 40 48" aria-hidden="true">${SAILOR}</svg>`;
      kids.push(c);
    }
    for (const r of vacant) {
      kids.push(cabin(r.id, r.scope || r.description || 'off watch', 'k-secondmate vacant', () => openDrawer({ type: 'secondmate', id: r.id })));
    }
    ui.cabinRow.replaceChildren(...kids);
  }

  // ---------- hold ----------
  function renderHold() {
    const queued = snap.backlog.queued || [];
    const shown = queued.filter(matchesCrate);
    const calls = queued.filter((q) => q.captainCall).length;
    ui.holdSub.textContent = `${queued.length} queued${calls ? ` · ${calls} awaiting the captain` : ''}`;
    ui.hold.classList.toggle('hidden-by-filter', !!(query || stateFilter) && !shown.length);
    if (unchanged('hold', queued, shown.length, snap.backlog.present)) return;
    const kids = shown.slice(0, MAX_CRATES).map((q, i) => {
      const key = q.id || `item-${i}`;
      return h('button', {
        class: 'crate' + (q.captainCall ? ' captain-call' : ''), type: 'button',
        title: `${q.id || ''}\n${q.title}`,
        onclick: () => openDrawer({ type: 'backlog', id: key, section: 'queued', index: queued.indexOf(q) }),
      }, h('span', { text: q.id || q.title }));
    });
    if (shown.length > MAX_CRATES) kids.push(h('div', { class: 'crate more', text: `+${shown.length - MAX_CRATES} more` }));
    if (!queued.length) kids.push(h('p', { class: 'hold-empty', text: snap.backlog.present ? 'The hold is empty.' : 'No backlog found (data/backlog.md).' }));
    ui.crates.replaceChildren(...kids);
  }

  // ---------- bridge ----------
  function renderBridge() {
    ui.captain.classList.toggle('away', snap.afk);
    ui.awaySign.hidden = !snap.afk;
    const w = snap.watcher;
    ui.lamp.className = 'lamp ' + (w.lastBeat ? (w.healthy ? 'on' : 'amber') : '');
    ui.lampLabel.textContent = w.lastBeat ? (w.healthy ? 'Watch ' : 'Watch stale ') + ago(w.lastBeat) : 'No watch';
    ui.lamp.parentElement.title = w.lastBeat ? `Watcher heartbeat ${agoLong(w.lastBeat)}` : 'No watcher heartbeat file';
    ui.wheel.style.animationPlayState = w.healthy ? 'running' : 'paused';
  }

  // ---------- orders: posting, confirm dialog, lifecycle ----------
  const KIND_LABEL = {
    chat: 'Chat', cleanup: 'Clean up', merge: 'Merge PR', answer: 'Answer', decision: 'Decision', status: 'Status?',
    'new-task': 'New job', 'cleanup-done': 'Clean up done', 'backlog-start': 'Start', 'backlog-answer': 'Answer call', config: 'Config', order: 'Order',
  };
  const IRREVERSIBLE = new Set(['merge', 'cleanup', 'cleanup-done']);
  const ORDER_COLOR = { pending: 'needs-decision', acknowledged: 'working', done: 'done', declined: 'failed' };

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      return { ...out, ok: res.ok && out.ok !== false, error: out.error || (res.ok ? null : 'HTTP ' + res.status) };
    } catch (e) {
      return { ok: false, error: 'cannot reach the server (your text is kept)' };
    }
  }

  // In-page confirm: resolves true only on an explicit "Queue order".
  let confirmResolve = null;
  function confirmDialog({ title, body, irreversible, yes = 'Queue order' }) {
    if (confirmResolve) confirmResolve(false);
    ui.confirmTitle.textContent = title;
    ui.confirmBody.replaceChildren(...(body === undefined || body === null ? [] : [typeof body === 'string' ? h('p', { class: 'confirm-text', text: body }) : body]));
    ui.confirmWarn.hidden = !irreversible;
    ui.confirmWarn.textContent = irreversible
      ? 'This cannot be undone once carried out. Ship Deck only queues the order: the first mate will still confirm with you before acting.'
      : '';
    ui.confirmYes.textContent = yes;
    ui.confirmYes.classList.toggle('danger', !!irreversible);
    ui.confirm.hidden = false;
    ui.confirmScrim.hidden = false;
    const back = document.activeElement;
    ui.confirmYes.focus();
    return new Promise((resolve) => {
      confirmResolve = (v) => {
        confirmResolve = null;
        ui.confirm.hidden = true;
        ui.confirmScrim.hidden = true;
        if (back && back.isConnected) back.focus({ preventScroll: true });
        resolve(v);
      };
    });
  }
  ui.confirmYes.addEventListener('click', () => confirmResolve && confirmResolve(true));
  ui.confirmNo.addEventListener('click', () => confirmResolve && confirmResolve(false));
  ui.confirmScrim.addEventListener('click', () => confirmResolve && confirmResolve(false));

  function describe(req) {
    const bits = [KIND_LABEL[req.kind] || req.kind];
    if (req.target) bits.push(req.target);
    if (req.item) bits.push(req.item);
    if (req.project) bits.push(`${req.taskKind || ''} in ${req.project}`.trim());
    return bits.join(' · ');
  }
  // Queues an order after the in-page confirm. Returns true when queued.
  async function queueOrder(req, confirm) {
    if (confirm !== false) {
      const c = confirm || {};
      const ok = await confirmDialog({
        title: c.title || `Queue “${describe(req)}” for the first mate?`,
        body: c.body !== undefined ? c.body : req.text || null,
        irreversible: IRREVERSIBLE.has(req.kind),
      });
      if (!ok) return false;
    }
    const r = await post('/api/orders', req);
    if (r.ok) {
      toast(`Queued for the first mate: ${describe(req)}`, 'ok');
      poll();
      return true;
    }
    toast(`Order not queued: ${r.error}`, 'err');
    return false;
  }
  function toast(text, kind) {
    const el = h('div', { class: 'toast ' + (kind || ''), role: kind === 'err' ? 'alert' : 'status', text });
    ui.toasts.append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, kind === 'err' ? 7000 : 3500);
  }

  function timeOf(ts) { const t = ts ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : null; }
  function clock(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
  function chip(status) { return h('span', { class: 'chip', style: `--c:${stateVar(ORDER_COLOR[status] || 'unknown')}`, text: status }); }
  function payloadText(o) {
    if (o.kind === 'cleanup-done' && o.targets) return `${o.targets.length} crew: ${o.targets.join(', ')}`;
    if (o.kind === 'new-task') return `${o.taskKind || 'job'} in ${o.project}${o.harness ? ` · ${o.harness}${o.model ? ' ' + o.model : ''}${o.effort ? ' · effort ' + o.effort : ''}` : ''}`;
    if (o.kind === 'config') return `${o.field} → ${o.value} · ${o.applied ? 'applied live' : 'on relaunch'}`;
    if (o.item) return o.item + (o.option ? ` · option ${o.option}` : '');
    if (o.option) return `option ${o.option}`;
    return '';
  }
  // queued -> acknowledged -> done/declined, with each step's time and note.
  function lifecycle(o) {
    const steps = [h('li', { class: 'lc-step done', style: `--c:${stateVar('needs-decision')}` }, h('b', { text: 'queued' }), ' ', clock(timeOf(o.ts)))];
    for (const a of o.history || []) {
      steps.push(h('li', { class: 'lc-step done', style: `--c:${stateVar(ORDER_COLOR[a.status] || 'unknown')}` },
        h('b', { text: a.status }), ' ', clock(timeOf(a.ts)), a.note ? h('span', { class: 'lc-note', text: ` · ${a.note}` }) : null));
    }
    if (o.status === 'pending' || o.status === 'acknowledged') {
      steps.push(h('li', { class: 'lc-step next', text: o.status === 'pending' ? 'waiting for the first mate' : 'in progress' }));
    }
    return h('ol', { class: 'lifecycle' }, ...steps);
  }

  function orderRow(o) {
    const when = timeOf(o.ts);
    const extra = payloadText(o);
    const inner = [
      h('span', { class: 'dot' }),
      h('span', { class: 'r-id' }, h('span', { class: 'o-kind', text: KIND_LABEL[o.kind] || o.kind }), o.target ? ' ' + o.target : ''),
      h('span', { class: 'r-age' }, chip(o.status), ' ', ago(when)),
      h('span', { class: 'r-note', text: o.text + (extra ? ` (${extra})` : '') }),
      h('span', { class: 'r-life' }, lifecycle(o)),
    ];
    const title = `${o.id}\n${o.status}${o.ackTs ? ' · ' + o.ackTs : ''}\nqueued ${o.ts}`;
    const attrs = { class: 'row' + (o.pending ? ' pending' : ''), style: `--c:${stateVar(ORDER_COLOR[o.status] || 'unknown')}`, title };
    return h('li', null, o.target && snap.tasks.some((t) => t.id === o.target)
      ? h('button', { ...attrs, type: 'button', onclick: () => openDrawer({ type: 'task', id: o.target }) }, ...inner)
      : h('div', attrs, ...inner));
  }

  // ---------- command center ----------
  function listRow(t, note, onclick) {
    return h('li', null, h('button', { class: 'row', type: 'button', onclick, style: `--c:${stateVar(bucket(t))}` },
      h('span', { class: 'dot' }), h('span', { class: 'r-id', text: t.id, title: t.id }), h('span', { class: 'r-age', text: ago(t.lastActivity) }),
      note ? h('span', { class: 'r-note', text: note }) : null,
      t.options && t.options.length ? h('span', { class: 'r-opts', text: `options ${t.options.map((o) => o.letter).join(' / ')}` }) : null));
  }
  function emptyRow(text) { return h('li', null, h('div', { class: 'empty', text })); }
  // A list row with an inline action button beside the clickable row.
  function actionRow(row, label, onclick) {
    return h('li', { class: 'with-action' }, row, h('button', { class: 'act-btn mini', type: 'button', text: label, onclick }));
  }
  function itemKey(b) { return b.id || b.title; }

  function renderPanel() {
    const w = snap.watcher;
    const lampCls = w.lastBeat ? (w.healthy ? 'on' : 'amber') : '';
    ui.watch.replaceChildren(
      h('div', { class: 'head' }, h('span', { class: 'lamp ' + lampCls }),
        w.lastBeat ? (w.healthy ? 'Watch is keeping' : 'Watch heartbeat is stale') : 'No watcher heartbeat'),
      h('span', { class: 'row-label', text: 'Heartbeat' }), h('span', { class: 'row-val', text: agoLong(w.lastBeat) }),
      h('span', { class: 'row-label', text: 'Captain' }), h('span', { class: 'row-val', text: snap.afk ? 'ashore (away)' : 'aboard' }),
      h('span', { class: 'row-label', text: 'Crew' }), h('span', { class: 'row-val', text: `${snap.tasks.length} in flight` }),
      h('span', { class: 'row-label', text: 'Stale after' }), h('span', { class: 'row-val', text: `${snap.staleDays} d without activity` }),
      h('span', { class: 'row-label', text: 'tmux' }), h('span', { class: 'row-val', text: snap.tmux.available ? `${snap.tmux.windows} windows` : 'not available' }),
      h('span', { class: 'row-label', text: 'Updated' }), h('span', { class: 'row-val', text: new Date(snap.generatedAt).toLocaleTimeString() }),
    );

    const states = [...COUNT_ORDER];
    if (snap.counts.unknown) states.push('unknown');
    if (!unchanged('counts', snap.counts, stateFilter)) ui.counts.replaceChildren(...states.map((s) => {
      const n = snap.counts[s] || 0;
      return h('button', {
        class: 'count' + (n ? '' : ' zero') + (stateFilter === s ? ' active' : ''), type: 'button',
        style: `--c:${stateVar(s)}`, 'aria-pressed': stateFilter === s ? 'true' : 'false',
        title: `Show only ${STATE_LABEL[s]}`,
        onclick: () => { stateFilter = stateFilter === s ? null : s; renderAll(); },
      }, h('span', { class: 'n', text: n }), h('span', { class: 'l', text: STATE_LABEL[s] }));
    }));

    const needs = needsCaptain();
    const calls = snap.backlog.calls || [];
    const sigOf = (list) => list.map((t) => [t.id, t.state, t.stale, ago(t.lastActivity), lastNote(t)]);
    ui.needsCount.textContent = needs.length;
    ui.needsCount.classList.toggle('zero', needs.length === 0);
    ui.needsTab.textContent = needs.length + calls.length;
    ui.needsTab.hidden = needs.length + calls.length === 0;
    if (!unchanged('needs', sigOf(needs))) ui.needsList.replaceChildren(...(needs.length
      ? needs.map((t) => listRow(t, lastNote(t), () => openDrawer({ type: 'task', id: t.id })))
      : [emptyRow('No crew waiting on the captain.')]));

    ui.callsCount.textContent = calls.length;
    ui.callsCount.classList.toggle('zero', calls.length === 0);
    if (!unchanged('calls', calls.map((b) => [b.id, b.title, b.section, b.index]))) ui.callsList.replaceChildren(...(calls.length ? calls.map((b) => {
      const open = (focus) => openDrawer({ type: 'backlog', id: itemKey(b), section: b.section, index: b.index, focus });
      const row = h('button', { class: 'row', type: 'button', style: `--c:${stateVar('needs-decision')}`, onclick: () => open(false) },
        h('span', { class: 'dot' }), h('span', { class: 'r-id', text: b.id || '(untitled)', title: b.id || '' }),
        h('span', { class: 'r-age', text: (b.tags && b.tags.since) || '' }), h('span', { class: 'r-note', text: b.title }));
      return b.id ? actionRow(row, 'Answer', () => open(true)) : h('li', null, row);
    }) : [emptyRow('No Captain\'s Call items in the backlog.')]));

    const queued = (snap.backlog.queued || []).map((b, index) => ({ b, index })).filter((x) => !x.b.captainCall && !x.b.checked);
    ui.queuedCount.textContent = queued.length;
    if (!unchanged('queued', queued.map((x) => [x.b.id, x.b.title, x.index]))) ui.queuedList.replaceChildren(...(queued.length ? queued.map(({ b, index }) => {
      const row = h('button', { class: 'row', type: 'button', style: `--c:${stateVar('unknown')}`, onclick: () => openDrawer({ type: 'backlog', id: itemKey(b), section: 'queued', index }) },
        h('span', { class: 'dot' }), h('span', { class: 'r-id', text: b.id || '(untitled)', title: b.id || '' }),
        h('span', { class: 'r-age', text: (b.tags && b.tags.since) || '' }), h('span', { class: 'r-note', text: b.title }));
      return b.id ? actionRow(row, 'Start', () => startBacklog(b)) : h('li', null, row);
    }) : [emptyRow('Nothing queued.')]));

    const doneAll = snap.tasks.filter((t) => t.state === 'done' && t.kind !== 'secondmate');
    const done = doneAll.slice().sort((a, b) => (b.statusMtime || 0) - (a.statusMtime || 0)).slice(0, 6);
    ui.cleanupDone.hidden = doneAll.length === 0;
    ui.cleanupDone.textContent = `Clean up all finished (${doneAll.length})`;
    if (!unchanged('done', sigOf(done), doneAll.length)) ui.doneList.replaceChildren(...(done.length
      ? done.map((t) => listRow(t, lastNote(t), () => openDrawer({ type: 'task', id: t.id })))
      : [emptyRow('Nothing finished yet.')]));

    const prs = snap.tasks.filter((t) => t.pr).sort(sortTasks);
    if (!unchanged('prs', sigOf(prs).map((x, i) => [...x, prs[i].pr]))) ui.prList.replaceChildren(...(prs.length ? prs.map((t) => h('li', null,
      h('a', { class: 'row', href: t.pr, target: '_blank', rel: 'noopener noreferrer', style: `--c:${stateVar(bucket(t))}` },
        h('span', { class: 'dot' }), h('span', { class: 'r-id', text: t.id }), h('span', { class: 'r-age', text: prNumber(t.pr) })))) : [emptyRow('No PRs recorded in meta.')]));

    const ord = snap.orders || { pending: 0, list: [] };
    ui.ordersCount.textContent = ord.pending;
    ui.ordersCount.classList.toggle('zero', !ord.pending);
    if (!unchanged('orders', ord.list, ord.pending)) ui.ordersList.replaceChildren(...(ord.list.length
      ? ord.list.slice(0, 20).map(orderRow)
      : [emptyRow('No orders yet.')]));

    renderJobProjects();
    renderJobConfig();
  }

  function needsCaptain() { return snap.tasks.filter((t) => ATTENTION.has(t.state) && !t.stale).sort(sortTasks); }

  ui.cleanupDone.addEventListener('click', () => {
    const ids = snap.tasks.filter((t) => t.state === 'done' && t.kind !== 'secondmate').map((t) => t.id).sort();
    if (!ids.length) return;
    queueOrder({ kind: 'cleanup-done', targets: ids }, {
      title: `Clean up all ${ids.length} finished crew?`,
      body: h('div', null, h('p', { class: 'confirm-text', text: 'One order listing every finished crew member:' }), h('ul', { class: 'confirm-list' }, ...ids.map((id) => h('li', { text: id })))),
    });
  });

  // ---------- new job ----------
  function renderJobProjects() {
    const names = snap.projects.length ? snap.projects.map((p) => [p.name, p.mode]) : [...new Set(snap.tasks.map((t) => t.project))].sort().map((n) => [n, null]);
    if (unchanged('job-projects', names)) return;
    const want = ui.jobProject.value || store.get('draft.job.project');
    ui.jobProject.replaceChildren(h('option', { value: '', text: names.length ? 'Choose a project…' : 'No projects in data/projects.md' }),
      ...names.map(([n, mode]) => h('option', { value: n, text: mode ? `${n}  ·  ${mode}` : n })));
    if (want && names.some(([n]) => n === want)) ui.jobProject.value = want;
  }
  // Harness/model/effort pickers from the server's allow-list; '' model = first mate default.
  function fillSelect(sel, items, want) {
    sel.replaceChildren(...items.map(([v, label]) => h('option', { value: v, text: label })));
    sel.value = items.some(([v]) => v === want) ? want : items[0][0];
  }
  function renderJobConfig() {
    const o = snap.configOptions;
    if (!o || unchanged('job-config', o, ui.jobHarness.value)) return;
    if (!ui.jobHarness.options.length) fillSelect(ui.jobHarness, Object.keys(o).map((k) => [k, k]), store.get('draft.job.harness') || 'claude');
    const spec = o[ui.jobHarness.value] || {};
    fillSelect(ui.jobModel, [['', 'Default'], ...(spec.model || []).map((m) => [m, m])], store.get('draft.job.model') || '');
    fillSelect(ui.jobEffort, [['auto', 'Auto'], ...(spec.effort || []).map((e) => [e, e])], store.get('draft.job.effort') || 'auto');
    ui.jobModel.disabled = !spec.model;
    ui.jobEffort.disabled = !spec.effort;
  }
  for (const [el, key] of [[ui.jobHarness, 'harness'], [ui.jobModel, 'model'], [ui.jobEffort, 'effort']]) {
    el.addEventListener('change', () => { store.set('draft.job.' + key, el.value); if (key === 'harness') { store.set('draft.job.model', null); store.set('draft.job.effort', null); renderJobConfig(); } });
  }
  persist(ui.jobProject, 'job.project');
  persist(ui.jobText, 'job.text');
  const savedKind = store.get('draft.job.kind');
  for (const r of ui.jobForm.querySelectorAll('input[name="job-kind"]')) {
    if (savedKind && r.value === savedKind) r.checked = true;
    r.addEventListener('change', () => store.set('draft.job.kind', r.value));
  }
  if (store.get('draft.job.text')) ui.newJob.open = true;
  ui.jobForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const project = ui.jobProject.value;
    const taskKind = ui.jobForm.querySelector('input[name="job-kind"]:checked').value;
    const text = ui.jobText.value.trim();
    if (!project) { ui.jobProject.focus(); return; }
    if (!text) { ui.jobText.focus(); return; }
    const harness = ui.jobHarness.value || 'claude';
    const model = ui.jobModel.disabled ? '' : ui.jobModel.value;
    const effort = ui.jobEffort.disabled ? 'auto' : ui.jobEffort.value;
    const setup = `${harness} · ${model || 'first mate default model'} · effort ${effort}`;
    const ok = await queueOrder({ kind: 'new-task', project, taskKind, harness, model, effort, text }, {
      title: `Queue a new ${taskKind} job in ${project}?`, body: `${text}\n\n(${setup})`,
    });
    if (ok) { clearDraft(ui.jobText); }
  });

  async function startBacklog(b, note) {
    return queueOrder({ kind: 'backlog-start', item: b.id, text: note || `Start ${b.id}: ${b.title}` }, {
      title: `Start backlog item ${b.id}?`, body: b.title,
    });
  }

  // ---------- drawer ----------
  function fact(dl, label, value, mono) {
    if (value === null || value === undefined || value === '') return;
    dl.append(h('dt', { text: label }), h('dd', { class: mono ? 'mono' : null }, value));
  }

  function renderDrawer() {
    if (!selected || !snap) return;
    if (selected.type === 'task') return renderTaskDrawer();
    stopPeek();
    td = null;
    if (selected.type === 'backlog') return renderBacklogDrawer();
    if (selected.type === 'secondmate') return renderSecondmateDrawer();
    if (selected.type === 'firstmate') return renderFirstMateDrawer();
  }

  // Copies text, falling back to a hidden textarea where the clipboard API is missing.
  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { btn.textContent = prev; }, 1300);
    }
  }

  // "Resume in terminal" block for a session view from the server.
  function resumeBlock(sess) {
    const wrap = h('div', { class: 'resume' });
    if (!sess || !sess.resume) {
      wrap.append(h('p', { class: 'empty', text: (sess && sess.note) || 'No session recorded.' }));
      return wrap;
    }
    const btn = h('button', { class: 'act-btn', type: 'button', text: 'Copy', title: 'Copy the resume command' });
    btn.addEventListener('click', () => copyText(sess.resume, btn));
    wrap.append(h('div', { class: 'resume-row' }, h('code', { class: 'resume-cmd', text: sess.resume, tabindex: '0' }), btn),
      h('p', { class: 'hint resume-meta', text: `${sess.harness || 'claude'} session${sess.firstSeen ? ' · found ' + agoLong(sess.firstSeen) : ''}${sess.lastSeen ? ' · seen ' + agoLong(sess.lastSeen) : ''}` }));
    return wrap;
  }

  // The task drawer keeps its interactive parts (pane peek, message box, order
  // buttons, file viewer) across polls; only the facts are rebuilt each tick.
  let td = null; // { id, root, info, decision, resume, orders, peek, file, ... }

  function renderTaskDrawer() {
    const t = snap.tasks.find((x) => x.id === selected.id);
    if (!t) {
      stopPeek();
      td = null;
      ui.drawerKicker.replaceChildren('Left the ship');
      ui.drawerTitle.textContent = selected.id;
      ui.drawerBody.replaceChildren(h('p', { text: 'This task no longer has a meta file in state/. It was probably torn down. Its session stays listed under Sessions.' }));
      return;
    }
    ui.drawerKicker.replaceChildren(...[h('span', { class: 'pill', style: `background:${stateVar(t.state)}`, text: STATE_LABEL[t.state] }),
      t.stale ? h('span', { class: 'pill', style: `background:${stateVar('stale')}`, text: 'stale' }) : null, t.kind].filter(Boolean));
    ui.drawerTitle.textContent = t.id;
    if (!td || td.id !== t.id || !td.root.isConnected) buildTaskDrawer(t);
    td.task = t;
    if (!unchanged('drawer-info', t, snap.tmux.available)) td.info.replaceChildren(...taskInfo(t));
    if (!unchanged('drawer-decision', t.id, t.state, lastNote(t), t.options)) renderDecision(t);
    if (!unchanged('drawer-resume', t.id, t.session)) td.resume.replaceChildren(h('h3', { text: 'Resume in terminal' }), resumeBlock(t.session));
    if (!unchanged('drawer-config', t.id, t.config, t.window, snap.configOptions)) renderConfig(t);
    renderTaskOrders(t);
    td.peekWrap.hidden = !t.window;
    td.msgWrap.hidden = !t.window;
    td.mergeBtn.hidden = !t.pr;
  }

  function taskInfo(t) {
    const kids = [];
    if (t.brief) kids.push(h('p', { class: 'brief', text: t.brief }));
    const links = h('div', { class: 'links' });
    if (t.pr) links.append(h('a', { class: 'link-btn', href: t.pr, target: '_blank', rel: 'noopener noreferrer', text: `Pull request ${prNumber(t.pr)} ↗` }));
    for (const name of t.files || []) {
      links.append(h('button', { class: 'link-btn', type: 'button', title: `data/${t.id}/${name} (read-only)`, onclick: () => openDataFile(t.id, name) },
        h('span', { class: 'file-ico', 'aria-hidden': 'true', text: '¶' }), name));
    }
    if (t.worktree) {
      const b = h('button', { class: 'link-btn copy', type: 'button', text: 'Copy worktree path' });
      b.addEventListener('click', () => copyText(t.worktree, b));
      links.append(b);
    }
    if (links.childNodes.length) kids.push(links);
    const dl = h('dl', { class: 'facts' });
    fact(dl, 'Project', t.project);
    fact(dl, 'Kind', t.kind);
    fact(dl, 'Mode', t.mode);
    fact(dl, 'Harness', [t.harness, t.model && `model ${t.model}`, t.effort && `effort ${t.effort}`].filter(Boolean).join(' · '));
    fact(dl, 'Window', t.window ? `${t.window}${t.alive === true ? '  (open)' : t.alive === false ? '  (closed)' : ''}` : null, true);
    fact(dl, 'Worktree', t.worktree, true);
    fact(dl, 'PR head', t.prHead ? t.prHead.slice(0, 12) : null, true);
    fact(dl, 'Last activity', t.lastActivity ? `${agoLong(t.lastActivity)} · ${stamp(t.lastActivity)}` : null);
    if (t.stale) fact(dl, 'Stale', staleText(t));
    fact(dl, 'Turn ended', t.turnEnded ? `${agoLong(t.turnEnded)} · ${stamp(t.turnEnded)}` : 'not yet');
    fact(dl, 'Status lines', String(t.statusCount));
    kids.push(dl);
    kids.push(h('h3', { text: `Latest status (${Math.min(5, t.lastStatus.length)} of ${t.statusCount})` }));
    if (!t.lastStatus.length) kids.push(h('p', { class: 'empty', text: 'No status reported yet.' }));
    else {
      kids.push(h('ol', { class: 'timeline' }, ...t.lastStatus.slice().reverse().map((e) => {
        const when = e.ts || (e.approxTs ? `≈ ${stamp(e.approxTs)}` : 'no timestamp');
        const note = h('div', { class: 't-note', text: e.note, title: 'Click to expand' });
        note.addEventListener('click', () => note.classList.toggle('expanded'));
        return h('li', { style: `--c:${stateVar(e.state === 'resolved' ? 'working' : e.state)}` },
          h('div', { class: 't-head' }, h('strong', { text: e.state }), e.key ? h('span', { text: `[${e.key}]` }) : null, h('span', { text: when })),
          note);
      })));
    }
    return kids;
  }

  // Lettered option buttons plus a free-text answer; one shared builder for crew
  // decisions and Captain's Call backlog items.
  function answerPanel({ options, draftKey, placeholder, send }) {
    const text = persist(h('textarea', { rows: '3', maxlength: '2000', placeholder, 'aria-label': placeholder }), draftKey);
    const opts = (options || []).map((o) => h('button', {
      class: 'option-btn' + (o.recommended ? ' rec' : ''), type: 'button', title: `Answer with option ${o.letter}`,
      onclick: async () => { if (await send(o, text.value.trim())) clearDraft(text); },
    }, h('span', { class: 'opt-letter', text: o.letter }), h('span', { class: 'opt-text', text: o.text }), o.recommended ? h('span', { class: 'opt-rec', text: 'recommended' }) : null));
    const sendBtn = h('button', { class: 'act-btn primary', type: 'button', text: 'Send answer', onclick: async () => {
      if (!text.value.trim()) { text.focus(); return; }
      if (await send(null, text.value.trim())) clearDraft(text);
    } });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBtn.click(); } });
    return h('div', { class: 'answer' },
      opts.length ? h('div', { class: 'options', role: 'group', 'aria-label': 'Options' }, ...opts) : null,
      opts.length ? h('p', { class: 'hint', text: 'Click an option to answer with it; anything in the box below is sent along with it.' }) : null,
      text, h('div', { class: 'btn-row end' }, sendBtn));
  }
  function answerText(opt, extra) {
    return opt ? `(${opt.letter}) ${opt.text}${extra ? '\n\n' + extra : ''}` : extra;
  }

  function renderDecision(t) {
    if (!ATTENTION.has(t.state) || t.state === 'failed') { td.decision.hidden = true; td.decision.replaceChildren(); return; }
    td.decision.hidden = false;
    td.decision.replaceChildren(
      h('h3', { text: t.state === 'blocked' ? 'Blocked: help it along' : 'Decision needed' }),
      h('div', { class: 'decision-note', text: lastNote(t) || '(no note)' }),
      answerPanel({
        options: t.options,
        draftKey: 'decision.' + t.id,
        placeholder: t.options.length ? 'Optional note or your own answer…' : 'Your answer…',
        send: (opt, extra) => queueOrder({ kind: 'decision', target: t.id, option: opt ? opt.letter : null, text: answerText(opt, extra) }, {
          title: opt ? `Answer ${t.id} with option ${opt.letter}?` : `Send this answer to ${t.id}?`,
          body: answerText(opt, extra),
        }),
      }));
  }

  // Current harness/model/effort with allow-listed pickers; claude workers apply live.
  function renderConfig(t) {
    const c = t.config || { harness: t.harness || 'claude', model: t.model, effort: t.effort, pending: {} };
    const spec = (snap.configOptions || {})[c.harness] || {};
    const live = !!spec.live && !!t.window;
    const show = (field) => [c[field] || 'default', c.pending[field] ? ` → ${c.pending[field]} on relaunch` : ''].join('');
    const rows = [];
    for (const field of ['effort', 'model']) {
      const list = spec[field];
      if (!list) {
        rows.push(h('div', { class: 'cfg-row' }, h('span', { class: 'cfg-label', text: field }), h('span', { class: 'cfg-val mono', text: show(field) }), h('span', { class: 'hint cfg-fixed', text: 'show current only' })));
        continue;
      }
      const sel = h('select', { 'aria-label': `${field} for ${t.id}` }, ...list.map((v) => h('option', { value: v, text: v })));
      sel.value = list.includes(c.pending[field] || c[field]) ? (c.pending[field] || c[field]) : list[0];
      const btn = h('button', { class: 'act-btn', type: 'button', text: live ? 'Apply live' : 'Queue change', onclick: () => applyConfig(t, field, sel.value, live) });
      rows.push(h('div', { class: 'cfg-row' }, h('span', { class: 'cfg-label', text: field }), h('span', { class: 'cfg-val mono', text: show(field) }), sel, btn));
    }
    td.config.replaceChildren(h('h3', { text: 'Configuration' }),
      h('p', { class: 'hint', text: `Harness: ${c.harness}. ` + (live
        ? 'Changes are sent as /effort or /model to its terminal via fm-send; Claude Code queues slash commands, so they apply from its next turn.'
        : spec.live ? 'No tmux window recorded, so changes are queued for the first mate to apply on relaunch.'
          : `${c.harness} workers cannot change live; changes are queued for the first mate to apply on relaunch.`) }),
      ...rows);
  }
  async function applyConfig(t, field, value, live) {
    const ok = await confirmDialog({
      title: `Set ${field} of ${t.id} to ${value}?`,
      body: live
        ? `Sends “/${field} ${value}” into its terminal now (fm-send). It applies from the worker's next turn, and a config order is recorded for the first mate.`
        : `Queues a config order; the first mate applies it when it next relaunches ${t.id}.`,
      yes: live ? 'Apply now' : 'Queue change',
    });
    if (!ok) return;
    const r = await post('/api/config', { id: t.id, field, value });
    if (r.ok) { toast(r.applied ? `Sent ${r.command} to ${t.id}` : `Queued: ${t.id} ${field} → ${value} on relaunch`, 'ok'); poll(); }
    else toast(`Config change failed: ${r.error}`, 'err');
  }

  function buildTaskDrawer(t) {
    stopPeek();
    const id = t.id;
    const d = { id };

    // File viewer: replaces the drawer content while open.
    d.fileTitle = h('span', { class: 'mono' });
    d.fileMeta = h('span', { class: 'file-meta' });
    d.fileText = h('pre', { class: 'file-text', tabindex: '0' });
    d.file = h('section', { class: 'file-view', hidden: true },
      h('div', { class: 'file-head' },
        h('button', { class: 'act-btn', type: 'button', text: '← Back', onclick: () => closeDataFile() }),
        d.fileTitle, d.fileMeta),
      d.fileText);

    d.info = h('div', { class: 'task-info' });
    d.decision = h('section', { class: 'drawer-sec decision-sec', hidden: true });
    d.resume = h('section', { class: 'drawer-sec' });
    d.config = h('section', { class: 'drawer-sec config-sec' });

    // Orders to the first mate about this worker.
    d.mergeBtn = h('button', { class: 'act-btn', type: 'button', text: 'Merge its PR', onclick: () => queueOrder({ kind: 'merge', target: id }, { title: `Ask the first mate to merge ${id}'s PR?`, body: (td && td.task && td.task.pr) || null }) });
    d.ordersList = h('ul', { class: 'list orders compact' });
    const ordersSec = h('section', { class: 'drawer-sec' },
      h('h3', { text: 'Orders to the first mate' }),
      h('p', { class: 'hint', text: 'Queued for the first mate to act on; Ship Deck does not run them.' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'act-btn', type: 'button', text: 'Ask for status', onclick: () => queueOrder({ kind: 'status', target: id }) }),
        d.mergeBtn,
        h('button', { class: 'act-btn', type: 'button', text: 'Clean up this worker', onclick: () => queueOrder({ kind: 'cleanup', target: id }, { title: `Ask the first mate to clean up ${id}?`, body: 'Tears down its window and worktree once its work is safe.' }) })),
      d.ordersList);

    // Message the worker directly (fm-send), with a confirmation step.
    const msg = persist(h('input', { type: 'text', maxlength: '2000', placeholder: 'Message to this worker (one line)…', 'aria-label': `Message to ${id}`, autocomplete: 'off' }), 'msg.' + id);
    const sendBtn = h('button', { class: 'act-btn primary', type: 'submit', text: 'Send' });
    const form = h('form', { class: 'msg-form' }, msg, sendBtn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = msg.value.replace(/\s+/g, ' ').trim();
      if (!text) { msg.focus(); return; }
      if (!await confirmDialog({ title: `Send to ${id} now?`, body: text, yes: 'Send now' })) return;
      sendBtn.disabled = true;
      const r = await post('/api/send', { id, message: text });
      sendBtn.disabled = false;
      if (r.ok) { clearDraft(msg); toast(`Sent to ${id}`, 'ok'); setTimeout(refreshPeek, 600); }
      else toast(`Send to ${id} failed: ${r.error || 'unknown error'}`, 'err');
    });
    d.msgWrap = h('section', { class: 'drawer-sec' },
      h('h3', { text: 'Message the worker' }),
      h('p', { class: 'hint', text: 'Types one line into its tmux window via fm-send. Use sparingly: it bypasses the first mate.' }),
      form);

    // Live terminal peek.
    d.peekText = h('pre', { class: 'peek', tabindex: '0', 'aria-label': `Terminal of ${id}` });
    d.peekState = h('span', { class: 'peek-state' });
    d.pauseBtn = h('button', { class: 'act-btn', type: 'button', 'aria-pressed': 'false', text: 'Pause refresh', onclick: () => {
      d.paused = !d.paused;
      d.pauseBtn.textContent = d.paused ? 'Resume refresh' : 'Pause refresh';
      d.pauseBtn.setAttribute('aria-pressed', d.paused ? 'true' : 'false');
      if (!d.paused) refreshPeek();
      setPeekState();
    } });
    d.peekWrap = h('section', { class: 'drawer-sec' },
      h('div', { class: 'sec-head' }, h('h3', { text: 'Terminal' }), d.peekState, d.pauseBtn),
      d.peekText);

    d.root = h('div', { class: 'task-drawer' }, d.file, d.decision, d.info, d.resume, d.config, ordersSec, d.peekWrap, d.msgWrap);
    ui.drawerBody.replaceChildren(d.root);
    ui.drawerBody.scrollTop = 0;
    for (const k of ['drawer-info', 'drawer-orders', 'drawer-decision', 'drawer-resume', 'drawer-config']) sigs.delete(k);
    td = d;
    if (t.window) startPeek();
  }

  function renderTaskOrders(t) {
    const mine = ((snap.orders && snap.orders.list) || []).filter((o) => o.target === t.id || (o.targets && o.targets.includes(t.id)));
    if (unchanged('drawer-orders', t.id, mine)) return;
    td.ordersList.replaceChildren(...(mine.length ? mine.slice(0, 8).map(orderRow) : [emptyRow('No orders about this worker yet.')]));
  }

  // ---------- terminal peek ----------
  const PEEK_MS = 2000;
  let peekTimer = null;
  let peekBusy = false;
  function setPeekState(text) {
    if (!td) return;
    if (text !== undefined) td.peekNote = text;
    td.peekState.textContent = td.paused ? 'paused' : (td.peekNote || '');
  }
  async function refreshPeek() {
    if (!td || peekBusy || td.paused || document.hidden || !td.file.hidden) return;
    const d = td;
    peekBusy = true;
    try {
      const res = await fetch(`/api/peek/${encodeURIComponent(d.id)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (td !== d) return;
      const pre = d.peekText;
      const atBottom = !d.peekLoaded || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      if (res.ok) {
        if (pre.textContent !== body.text) pre.textContent = body.text;
        pre.classList.remove('peek-err');
        setPeekState(`live · ${new Date().toLocaleTimeString()}`);
      } else {
        pre.textContent = body.error || `HTTP ${res.status}`;
        pre.classList.add('peek-err');
        setPeekState('unavailable');
      }
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      d.peekLoaded = true;
    } catch {
      setPeekState('offline');
    } finally {
      peekBusy = false;
    }
  }
  function startPeek() {
    stopPeek();
    refreshPeek();
    peekTimer = setInterval(refreshPeek, PEEK_MS);
  }
  function stopPeek() { clearInterval(peekTimer); peekTimer = null; }

  // ---------- data files (read-only) ----------
  async function openDataFile(id, name) {
    if (!td || td.id !== id) return;
    const d = td;
    d.fileTitle.textContent = `data/${id}/${name}`;
    d.fileMeta.textContent = 'loading…';
    d.fileText.textContent = '';
    d.file.hidden = false;
    d.root.classList.add('viewing-file');
    ui.drawerBody.scrollTop = 0;
    try {
      const res = await fetch(`/api/file/${encodeURIComponent(id)}/${encodeURIComponent(name)}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      d.fileText.textContent = body.text;
      d.fileMeta.textContent = `${(body.size / 1024).toFixed(1)} KB${body.truncated ? ' · truncated' : ''} · read-only`;
    } catch (e) {
      d.fileMeta.textContent = '';
      d.fileText.textContent = `Could not open: ${e.message}`;
    }
    d.fileText.focus({ preventScroll: true });
  }
  function closeDataFile() {
    if (!td || td.file.hidden) return false;
    td.file.hidden = true;
    td.root.classList.remove('viewing-file');
    refreshPeek();
    return true;
  }

  // ---------- backlog, secondmate and first mate drawers ----------
  function backlogItem() {
    const list = snap.backlog[selected.section] || [];
    const byIndex = list[selected.index];
    if (byIndex && itemKey(byIndex) === selected.id) return byIndex;
    return list.find((b) => itemKey(b) === selected.id);
  }

  function renderBacklogDrawer() {
    const b = backlogItem();
    const sectionName = { captain: "Captain's Call", inFlight: 'In flight', queued: 'Queued', done: 'Done', other: 'Backlog' }[selected.section] || 'Backlog';
    ui.drawerKicker.replaceChildren(`Backlog · ${sectionName}${b && b.captainCall ? " · Captain's Call" : ''}`);
    ui.drawerTitle.textContent = selected.id;
    if (!b) { ui.drawerBody.replaceChildren(h('p', { text: 'This backlog item is no longer listed.' })); return; }
    if (unchanged('drawer-backlog', selected.id, selected.section, b, (snap.orders && snap.orders.list || []).filter((o) => o.item === b.id))) return;
    const kids = [h('p', { class: 'brief', text: b.title })];
    const call = (snap.backlog.calls || []).find((c) => c.id && c.id === b.id);
    if (b.id && call) {
      kids.push(h('section', { class: 'drawer-sec decision-sec' },
        h('h3', { text: "Captain's Call: your answer" }),
        b.tags.hold ? h('div', { class: 'decision-note', text: b.tags.hold }) : null,
        answerPanel({
          options: call.options,
          draftKey: 'call.' + b.id,
          placeholder: call.options.length ? 'Optional note or your own answer…' : 'Your answer…',
          send: (opt, extra) => queueOrder({ kind: 'backlog-answer', item: b.id, option: opt ? opt.letter : null, text: answerText(opt, extra) }, {
            title: opt ? `Answer ${b.id} with option ${opt.letter}?` : `Send this answer on ${b.id}?`, body: answerText(opt, extra),
          }),
        })));
    } else if (b.id && selected.section === 'queued' && !b.checked) {
      const note = persist(h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Optional instructions for this job…', 'aria-label': 'Instructions' }), 'start.' + b.id);
      kids.push(h('section', { class: 'drawer-sec' },
        h('h3', { text: 'Start this' }),
        h('p', { class: 'hint', text: 'Queues an order asking the first mate to dispatch this backlog item.' }),
        h('div', { class: 'answer' }, note, h('div', { class: 'btn-row end' }, h('button', { class: 'act-btn primary', type: 'button', text: 'Start this', onclick: async () => {
          if (await startBacklog(b, note.value.trim() ? `Start ${b.id}: ${b.title}\n\n${note.value.trim()}` : null)) clearDraft(note);
        } })))));
    } else if (!b.id) {
      kids.push(h('p', { class: 'hint', text: 'This item has no id, so it cannot be ordered from here. Mention it in the Bridge chat instead.' }));
    }
    const dl = h('dl', { class: 'facts' });
    if (b.captainCall) fact(dl, 'Needs', 'captain decision');
    for (const [k, v] of Object.entries(b.tags || {})) if (!(call && k === 'hold')) fact(dl, k, v.length > 600 ? v.slice(0, 600) + '…' : v);
    kids.push(h('h3', { text: 'Details' }), dl);
    if (b.notes.length) kids.push(h('h3', { text: 'Notes' }), h('pre', { class: 'notes-block', text: b.notes.join('\n') }));
    const mine = ((snap.orders && snap.orders.list) || []).filter((o) => o.item === b.id);
    if (mine.length) kids.push(h('h3', { text: 'Orders about this item' }), h('ul', { class: 'list orders compact' }, ...mine.slice(0, 6).map(orderRow)));
    ui.drawerBody.replaceChildren(...kids);
    if (selected.focus) { selected.focus = false; const ta = ui.drawerBody.querySelector('textarea'); if (ta) ta.focus(); }
  }

  function renderSecondmateDrawer() {
    const r = (snap.secondmates.registry || []).find((x) => x.id === selected.id);
    ui.drawerKicker.replaceChildren('Secondmate · registry');
    ui.drawerTitle.textContent = selected.id;
    if (!r) { ui.drawerBody.replaceChildren(h('p', { text: 'Not in data/secondmates.md any more.' })); return; }
    const dl = h('dl', { class: 'facts' });
    fact(dl, 'About', r.description);
    fact(dl, 'Home', r.home, true);
    fact(dl, 'Scope', r.scope);
    fact(dl, 'Projects', r.projects);
    ui.drawerBody.replaceChildren(dl, h('p', { class: 'empty', text: 'No live meta record: this secondmate is off watch.' }));
  }

  function renderFirstMateDrawer() {
    ui.drawerKicker.replaceChildren('At the helm');
    ui.drawerTitle.textContent = 'First mate';
    const sess = snap.firstmate && snap.firstmate.session;
    if (unchanged('drawer-fm', sess, snap.watcher, snap.orders && snap.orders.pending)) return;
    const dl = h('dl', { class: 'facts' });
    fact(dl, 'Home', snap.home, true);
    fact(dl, 'Watch', snap.watcher.lastBeat ? `${snap.watcher.healthy ? 'keeping' : 'stale'} · beat ${agoLong(snap.watcher.lastBeat)}` : 'no heartbeat');
    fact(dl, 'Pending orders', String((snap.orders && snap.orders.pending) || 0));
    ui.drawerBody.replaceChildren(dl,
      h('div', { class: 'btn-row' }, h('button', { class: 'act-btn primary', type: 'button', text: 'Open the Bridge chat', onclick: () => { closeDrawer(); showTab('bridge'); ui.chatText.focus(); } })),
      h('section', { class: 'drawer-sec' }, h('h3', { text: 'Resume in terminal' }),
        h('p', { class: 'hint', text: 'The newest Claude Code session started in the fleet home.' }), resumeBlock(sess)));
  }

  function openDrawer(sel) {
    if (!selected || selected.type !== sel.type || selected.id !== sel.id) { stopPeek(); td = null; }
    sigs.delete('drawer-backlog');
    sigs.delete('drawer-fm');
    const wantFocus = !!sel.focus;
    selected = sel;
    ui.drawer.classList.add('open');
    ui.drawer.setAttribute('aria-hidden', 'false');
    ui.scrim.hidden = false;
    renderDrawer();
    for (const [id, el] of stations) el.classList.toggle('selected', sel.type === 'task' && sel.id === id);
    const want = sel.type === 'task' ? `#task=${encodeURIComponent(sel.id)}` : '';
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
    if (!wantFocus) ui.drawer.focus({ preventScroll: true });
  }
  function closeDrawer() {
    stopPeek();
    td = null;
    selected = null;
    ui.drawer.classList.remove('open');
    ui.drawer.setAttribute('aria-hidden', 'true');
    ui.scrim.hidden = true;
    for (const el of stations.values()) el.classList.remove('selected');
    if (location.hash) history.replaceState(null, '', location.pathname);
  }
  ui.drawerClose.addEventListener('click', closeDrawer);
  ui.scrim.addEventListener('click', closeDrawer);
  const openFirstMate = () => { if (snap) openDrawer({ type: 'firstmate', id: 'first-mate' }); };
  ui.firstmate.addEventListener('click', openFirstMate);
  ui.firstmate.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFirstMate(); } });

  // ---------- panel tabs ----------
  let activeTab = 'bridge';
  function showTab(name) {
    if (!ui.panes[name]) name = 'bridge';
    activeTab = name;
    for (const [k, tab] of Object.entries(ui.tabs)) {
      const on = k === name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      ui.panes[k].hidden = !on;
    }
    store.set('tab', name);
    if (name === 'bridge') { scrollThread(true); markSeen(); }
    if (name === 'sessions') loadSessions(true);
    if (name === 'activity') renderActivity();
  }
  for (const [k, tab] of Object.entries(ui.tabs)) {
    tab.addEventListener('click', () => showTab(k));
    tab.addEventListener('keydown', (e) => {
      const keys = Object.keys(ui.tabs);
      const i = keys.indexOf(k);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
        showTab(next);
        ui.tabs[next].focus();
      }
    });
  }

  // ---------- resizable side panel ----------
  // The panel width lives in --panel-w on .layout; CSS clamps it to 320px..70vw.
  const PANEL_MIN = 320;
  const PANEL_DEFAULT = 400;
  const panelMax = () => Math.max(PANEL_MIN, Math.floor(window.innerWidth * 0.7));
  const panelWidth = () => Math.round(ui.panel.getBoundingClientRect().width) || PANEL_DEFAULT;
  function setPanelWidth(w, save) {
    if (w === null) ui.layout.style.removeProperty('--panel-w');
    else ui.layout.style.setProperty('--panel-w', Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, w))) + 'px');
    if (save) store.set('panelWidth', w === null ? null : Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, w))));
    syncResizeAria();
  }
  function syncResizeAria() {
    ui.panelResize.setAttribute('aria-valuemin', PANEL_MIN);
    ui.panelResize.setAttribute('aria-valuemax', panelMax());
    ui.panelResize.setAttribute('aria-valuenow', panelWidth());
  }
  ui.panelResize.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ui.panelResize.focus();
    document.body.classList.add('resizing');
    const right = ui.panel.getBoundingClientRect().right;
    const move = (ev) => setPanelWidth(right - ev.clientX, false);
    // Window listeners keep the drag going even when the pointer outruns the handle.
    const up = () => {
      for (const [ev, fn] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) window.removeEventListener(ev, fn);
      document.body.classList.remove('resizing');
      store.set('panelWidth', panelWidth());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  ui.panelResize.addEventListener('dblclick', () => setPanelWidth(null, true));
  ui.panelResize.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const w = panelWidth();
    if (e.key === 'ArrowLeft') setPanelWidth(w + step, true);
    else if (e.key === 'ArrowRight') setPanelWidth(w - step, true);
    else if (e.key === 'Home') setPanelWidth(PANEL_MIN, true);
    else if (e.key === 'End') setPanelWidth(panelMax(), true);
    else if (e.key === 'Enter') setPanelWidth(null, true);
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', syncResizeAria);
  { const saved = Number(store.get('panelWidth')); if (saved >= PANEL_MIN) setPanelWidth(saved, false); else syncResizeAria(); }

  // ---------- first mate activity (read-only, from its own transcript) ----------
  const ACT_ICON = { shell: '⌨️', browser: '🧭', read: '📖', edit: '✏️', write: '📝', agent: '👥', publish: '📤', tool: '🔧', text: '💬', session: '⚓' };
  const ACT_MAX = 200;
  const act = { epoch: null, rev: null, events: new Map(), working: false, running: false, lastAt: null, sessionId: null, loaded: false };
  const expanded = new Set(); // seqs of Bash events showing their command
  let actLoading = false;
  async function loadActivity() {
    if (actLoading) return;
    actLoading = true;
    try {
      const q = act.epoch ? `?since=${act.rev}&epoch=${encodeURIComponent(act.epoch)}` : '';
      const res = await fetch('/api/activity' + q, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const r = await res.json();
      if (r.full) act.events.clear();
      for (const e of r.events || []) act.events.set(e.seq, e);
      const seqs = [...act.events.keys()].sort((a, b) => a - b);
      for (const k of seqs.slice(0, Math.max(0, seqs.length - ACT_MAX))) act.events.delete(k);
      Object.assign(act, { epoch: r.epoch, rev: r.rev, working: r.working, running: r.running, lastAt: r.lastAt, sessionId: r.sessionId, loaded: true });
    } catch { /* the fleet poll shows connectivity */ }
    actLoading = false;
    renderActivity();
  }
  function clock(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
  function dur(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    return Math.floor(ms / 60000) + 'm' + String(Math.round((ms % 60000) / 1000)).padStart(2, '0') + 's';
  }
  function evStatus(e) {
    if (e.kind !== 'tool') return null;
    const text = { running: 'running…', done: '✓ ' + dur(e.duration), failed: '✗ failed ' + dur(e.duration), unknown: '—' }[e.status] || '';
    return h('span', { class: 'ev-status st-' + e.status, title: e.status === 'unknown' ? 'No result recorded (session changed)' : e.status, text: text.trim() });
  }
  function evRow(e) {
    if (e.kind === 'session') return h('li', { class: 'ev ev-session' }, h('span', { text: `${ACT_ICON.session} ${e.label}` }));
    let main;
    if (e.detail) {
      const d = h('details', { class: 'ev-cmd', ontoggle: () => (d.open ? expanded.add(e.seq) : expanded.delete(e.seq)) },
        h('summary', { title: 'Show the command', text: e.label }), h('pre', { class: 'mono', text: e.detail }));
      d.open = expanded.has(e.seq);
      main = d;
    } else main = h('span', { class: 'ev-label', text: e.kind === 'text' ? `“${e.label}”` : e.label });
    return h('li', { class: `ev ev-${e.kind}` + (e.status ? ' st-' + e.status : '') },
      h('time', { class: 'ev-time mono', text: clock(e.ts) }),
      h('span', { class: 'ev-icon', 'aria-hidden': 'true', text: ACT_ICON[e.kind === 'text' ? 'text' : e.icon] || ACT_ICON.tool }),
      h('div', { class: 'ev-main' }, main),
      evStatus(e));
  }
  function renderActivity() {
    const has = act.loaded && !!act.sessionId;
    const label = !has ? 'no session' : act.working ? 'working…' : 'idle';
    ui.fmPill.hidden = !has;
    ui.fmPill.textContent = label;
    ui.fmPill.className = 'fm-pill ' + (act.working ? 'on' : 'off');
    ui.activityDot.hidden = !act.working;
    ui.activityState.textContent = label;
    ui.activityState.className = 'fm-state ' + (act.working ? 'on' : 'off');
    ui.activitySub.textContent = has
      ? `Live from the first mate's transcript (read-only) · last line ${act.lastAt ? agoLong(act.lastAt) : 'unknown'}`
      : act.loaded ? 'No first mate Claude Code transcript found yet.' : 'Loading…';
    const list = [...act.events.values()].sort((a, b) => b.seq - a.seq);
    const latest = list.find((e) => e.kind === 'tool' || e.kind === 'text');
    ui.ticker.hidden = !latest;
    if (latest) {
      ui.tickerIcon.textContent = ACT_ICON[latest.kind === 'text' ? 'text' : latest.icon] || ACT_ICON.tool;
      ui.tickerText.textContent = latest.kind === 'text' ? `“${latest.label}”` : latest.label;
      ui.tickerAge.textContent = latest.status === 'running' ? 'running…' : latest.status === 'failed' ? 'failed · ' + ago(latest.ts) : ago(latest.ts);
      ui.ticker.classList.toggle('on', act.working);
    }
    if (activeTab !== 'activity' || unchanged('feed', act.epoch, act.rev, list.length)) return;
    ui.feed.replaceChildren(...(list.length ? list.map(evRow) : [emptyRow(has ? 'No tool calls in the transcript yet.' : 'Nothing to show until the first mate has a Claude Code session in its home.')]));
  }
  ui.ticker.addEventListener('click', () => showTab('activity'));

  // ---------- bridge chat ----------
  let threadSig = null;
  let thread = [];
  let threadLoading = false;
  let threadRendered = false;
  const lastReplyId = () => { const r = thread.filter((x) => x.type === 'reply'); return r.length ? r[r.length - 1].id : null; };

  async function loadThread(sig) {
    if (threadLoading) return;
    threadLoading = true;
    try {
      const res = await fetch('/api/thread', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      thread = body.items || [];
      threadSig = sig || body.sig;
      renderThread();
      notifyReplies();
    } catch { /* next poll retries */ } finally {
      threadLoading = false;
    }
  }

  function nearBottom() { const el = ui.thread; return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }
  let pinned = true; // the thread was at the bottom before late-loading media grew it
  function scrollThread(force) {
    if (force || nearBottom()) { ui.thread.scrollTop = ui.thread.scrollHeight; ui.threadJump.hidden = true; pinned = true; }
  }
  function mediaLoaded() { if (pinned) ui.thread.scrollTop = ui.thread.scrollHeight; }
  if (window.ResizeObserver) new ResizeObserver(mediaLoaded).observe(ui.thread); // the tray or a taller draft shrinks it
  function dayLabel(ms) {
    const d = new Date(ms);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  function excerpt(s, n = 90) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function threadItem(x, prev, byId) {
    const when = timeOf(x.ts);
    const stampEl = h('time', { datetime: x.ts || '', title: x.ts ? new Date(when).toLocaleString() : '', text: clock(when) });
    if (x.type === 'reply') {
      const body = h('div', { class: 'bubble md' });
      body.innerHTML = MD.render(x.text, { breaks: true }); // escaped by the renderer
      const ref = x.inReplyTo && byId.get(x.inReplyTo);
      const quote = ref && !(prev && prev.id === ref.id)
        ? h('button', { class: 'quote', type: 'button', title: 'Show the message this answers', onclick: () => flashMessage(ref.id) }, '↪ ', excerpt(ref.text, 70))
        : null;
      const unread = !seenId || x.id > seenId;
      return h('li', { class: 'msg mate' + (unread && seenId !== null ? ' unread' : ''), 'data-id': x.id },
        h('span', { class: 'fm-avatar small', 'aria-hidden': 'true' }, sailorSvg()),
        h('div', { class: 'msg-col' }, h('div', { class: 'msg-meta' }, h('strong', { text: 'First mate' }), stampEl), quote, x.text ? body : null, attachmentsBlock(x.attachments)));
    }
    const isChat = x.kind === 'chat';
    const head = isChat ? null : h('div', { class: 'order-head' }, h('span', { class: 'o-kind', text: KIND_LABEL[x.kind] || x.kind }), x.target ? h('span', { class: 'mono', text: x.target }) : null,
      payloadText(x) ? h('span', { class: 'o-extra', text: payloadText(x) }) : null);
    return h('li', { class: 'msg captain' + (isChat ? '' : ' action'), 'data-id': x.id },
      h('div', { class: 'msg-col' },
        h('div', { class: 'msg-meta' }, stampEl, chip(x.status)),
        h('div', { class: 'bubble' + (x.text || head ? '' : ' bare') }, head, x.text ? h('div', { class: 'bubble-text', text: x.text }) : null, attachmentsBlock(x.attachments)),
        x.history && x.history.length ? lifecycle(x) : null));
  }
  function sailorSvg() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 40 48');
    s.setAttribute('class', 'sailor');
    s.innerHTML = SAILOR;
    return s;
  }
  function flashMessage(id) {
    const el = ui.thread.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function renderThread() {
    const wasBottom = !threadRendered || nearBottom();
    const byId = new Map(thread.map((x) => [x.id, x]));
    const kids = [];
    let day = null;
    let prev = null;
    for (const x of thread) {
      const when = timeOf(x.ts);
      const label = when ? dayLabel(when) : null;
      if (label && label !== day) { kids.push(h('li', { class: 'day', text: label })); day = label; }
      kids.push(threadItem(x, prev, byId));
      prev = x;
    }
    if (!thread.length) {
      kids.push(h('li', { class: 'thread-empty' },
        h('p', { text: 'No messages yet.' }),
        h('p', { class: 'hint', text: 'Ask the first mate anything: “what needs me?”, “start the watcher fix”, “summarise PR 42”. Every message is queued as an order, and replies show up here.' })));
    }
    ui.thread.replaceChildren(...kids);
    threadRendered = true;
    if (wasBottom) scrollThread(true);
    else if (lastReplyId() && lastReplyId() !== seenId) ui.threadJump.hidden = false;
    markSeen();
  }
  ui.threadJump.addEventListener('click', () => { scrollThread(true); markSeen(); });
  ui.thread.addEventListener('scroll', () => { pinned = nearBottom(); if (pinned) { ui.threadJump.hidden = true; markSeen(); } });

  // Unread replies: newer than the last reply seen with the Bridge tab open.
  let seenId = store.get('seenReply');
  function markSeen() {
    const last = lastReplyId();
    if (!last || activeTab !== 'bridge' || document.hidden || !nearBottom()) return updateUnread();
    if (seenId !== last) { seenId = last; store.set('seenReply', last); }
    updateUnread();
  }
  function updateUnread() {
    const n = thread.filter((x) => x.type === 'reply' && (!seenId || x.id > seenId)).length;
    ui.unread.textContent = n;
    ui.unread.hidden = n === 0;
    document.title = (n ? `(${n}) ` : '') + 'Ship Deck';
  }

  async function sendChat() {
    const text = ui.chatText.value.trim();
    if (attBusy()) { toast('Wait for the attachments to finish uploading', 'err'); return; }
    if (outgoing.some((a) => a.state === 'error')) { toast('Remove the attachments that failed before sending', 'err'); return; }
    const ids = outgoing.map((a) => a.id);
    if (!text && !ids.length) { ui.chatText.focus(); return; }
    ui.chatSend.disabled = true;
    const r = await post('/api/orders', ids.length ? { kind: 'chat', text, attachments: ids } : { kind: 'chat', text });
    ui.chatSend.disabled = false;
    if (r.ok) {
      clearDraft(ui.chatText);
      clearOutgoing();
      thread.push({ type: 'order', ...r.order, history: [], pending: true });
      renderThread();
      scrollThread(true);
      poll();
    } else {
      toast(`Message not sent: ${r.error}`, 'err');
    }
    updateSendState();
    ui.chatText.focus();
  }

  // ---------- attachments ----------
  // Uploaded raw to POST /api/attachments as soon as they are added; a video also
  // gets JPEG stills (one per ~2 s, max 40, 1280px wide) so the first mate can see it.
  const ATT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  };
  const ATT_MAX = { image: 20 * 1024 * 1024, video: 200 * 1024 * 1024 };
  const FRAME_EVERY = 2;
  const MAX_FRAMES = 40;
  const FRAME_WIDTH = 1280;
  const MAX_ATTACH = 10;
  let outgoing = []; // { key, file, name, kind, url, state: uploading|frames|ready|error, note, id }
  let attSeq = 0;

  function attKind(file) {
    const ext = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [])[1];
    const mime = Object.values(ATT_MIME).includes(file.type) ? file.type : ATT_MIME[(ext || '').toLowerCase()];
    return mime ? mime.split('/')[0] : null;
  }
  function sizeText(n) { return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`; }
  const attBusy = () => outgoing.some((a) => a.state === 'uploading' || a.state === 'frames');

  function addFiles(list, pasted) {
    for (const file of list) {
      if (outgoing.length >= MAX_ATTACH) { toast(`At most ${MAX_ATTACH} attachments per message`, 'err'); break; }
      const kind = attKind(file);
      if (!kind) { toast(`${file.name || 'That file'}: only png, jpeg, gif, webp images and mp4, mov, webm videos`, 'err'); continue; }
      if (file.size > ATT_MAX[kind]) { toast(`${file.name}: ${kind}s are limited to ${ATT_MAX[kind] / 1048576} MB`, 'err'); continue; }
      const d = new Date();
      const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('') + '-' + [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
      const name = pasted && /^image\.\w+$/.test(file.name) ? `screenshot-${stamp}.${file.name.split('.').pop()}` : file.name;
      const a = { key: ++attSeq, file, name, kind, url: URL.createObjectURL(file), state: 'uploading', note: 'uploading…', id: null };
      outgoing.push(a);
      uploadAttachment(a);
    }
    renderTray();
  }
  function removeAttachment(a) {
    a.removed = true;
    if (a.xhr) a.xhr.abort();
    URL.revokeObjectURL(a.url);
    outgoing = outgoing.filter((x) => x !== a);
    renderTray();
  }
  function clearOutgoing() {
    for (const a of outgoing) URL.revokeObjectURL(a.url);
    outgoing = [];
    renderTray();
  }

  // Raw POST with upload progress; resolves with the JSON body or rejects with its error.
  function uploadRaw(url, blob, a, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      a.xhr = xhr;
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Ship-Deck', '1');
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        a.xhr = null;
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status === 200 && body.ok) resolve(body);
        else reject(new Error(body.error || 'HTTP ' + xhr.status));
      };
      xhr.onerror = () => { a.xhr = null; reject(new Error('cannot reach the server')); };
      xhr.onabort = () => { a.xhr = null; reject(new Error('cancelled')); };
      xhr.send(blob);
    });
  }

  async function uploadAttachment(a) {
    const set = (state, note) => { if (a.removed) return; a.state = state; a.note = note; renderTray(); };
    try {
      const r = await uploadRaw('/api/attachments?name=' + encodeURIComponent(a.name), a.file, a,
        (p) => { if (!a.removed) { a.note = `uploading ${Math.round(p * 100)}%`; renderTray(); } });
      if (a.removed) return;
      a.id = r.attachment.id;
      if (a.kind !== 'video') return set('ready', sizeText(a.file.size));
      set('frames', 'extracting frames…');
      let n = 0;
      try {
        n = await extractFrames(a);
      } catch (e) {
        if (a.removed) return;
        return set('ready', `no stills (${e.message}): the first mate cannot watch this video`);
      }
      set('ready', `${sizeText(a.file.size)} · ${n} still${n === 1 ? '' : 's'} for the first mate`);
    } catch (e) {
      set('error', e.message);
    }
  }

  function once(el, ok, ms = 8000) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener('error', onErr); fn(v); };
      const onOk = () => done(resolve);
      const onErr = () => done(reject, new Error('the browser cannot decode it'));
      const timer = setTimeout(() => done(reject, new Error('timed out reading the video')), ms);
      el.addEventListener(ok, onOk);
      el.addEventListener('error', onErr);
    });
  }
  async function seek(v, t) {
    const p = once(v, 'seeked');
    v.currentTime = t;
    await p;
  }

  // Draws stills with <video> + <canvas> and uploads them next to the video,
  // then frames/index.json with each still's timestamp. Returns the still count.
  async function extractFrames(a) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const meta = once(v, 'loadedmetadata');
    v.src = a.url;
    await meta;
    let dur = v.duration;
    if (!Number.isFinite(dur)) { // MediaRecorder webm has no duration until the end is seeked
      await seek(v, 1e7);
      dur = Number.isFinite(v.duration) ? v.duration : v.currentTime;
    }
    if (!v.videoWidth || !(dur >= 0)) throw new Error('no video track');
    const step = Math.max(FRAME_EVERY, dur / MAX_FRAMES);
    const count = Math.min(MAX_FRAMES, Math.floor(dur / step) + 1);
    const scale = Math.min(1, FRAME_WIDTH / v.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    const frames = [];
    for (let i = 0; i < count; i++) {
      if (a.removed) throw new Error('cancelled');
      a.note = `extracting frames ${i + 1}/${count}`;
      renderTray();
      const t = Math.min(i * step, Math.max(0, dur - 0.05));
      await seek(v, t);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob) throw new Error('could not encode a still');
      const file = `frame-${String(i + 1).padStart(4, '0')}.jpg`;
      await uploadRaw(`/api/attachments?parent=${a.id}&name=${file}`, blob, a);
      frames.push({ file, t: Math.round(t * 1000) / 1000 });
    }
    const index = { duration: dur, width: canvas.width, height: canvas.height, frames };
    await uploadRaw(`/api/attachments?parent=${a.id}&name=index.json`, new Blob([JSON.stringify(index)], { type: 'application/json' }), a);
    v.removeAttribute('src');
    v.load();
    return frames.length;
  }

  // Each chip is built once and then only its note and state change (no thumbnail reloads).
  function renderTray() {
    ui.attTray.hidden = !outgoing.length;
    for (const a of outgoing) {
      if (!a.el) {
        const thumb = a.kind === 'image'
          ? h('img', { src: a.url, alt: '' })
          : h('video', { src: a.url, muted: true, preload: 'metadata', 'aria-hidden': 'true' });
        a.noteEl = h('span', { class: 'att-note' });
        a.el = h('li', { title: a.name },
          h('span', { class: 'att-thumb' + (a.kind === 'video' ? ' is-video' : '') }, thumb),
          h('span', { class: 'att-info' }, h('span', { class: 'att-name', text: a.name }), a.noteEl),
          h('button', { class: 'att-x', type: 'button', 'aria-label': `Remove ${a.name}`, title: 'Remove', text: '×', onclick: () => removeAttachment(a) }));
      }
      a.el.className = `att-chip ${a.state}`;
      a.noteEl.textContent = a.note;
    }
    const els = outgoing.map((a) => a.el);
    if (els.length !== ui.attTray.children.length || els.some((el, i) => ui.attTray.children[i] !== el)) ui.attTray.replaceChildren(...els);
    updateSendState();
  }
  function updateSendState() {
    const busy = attBusy();
    ui.chatSend.disabled = busy;
    ui.chatHint.textContent = busy ? 'Waiting for attachments…' : 'Enter to send · Shift+Enter for a new line';
  }

  // Attachments in the thread, served by GET /api/attachments/<id>. Elements are
  // reused across re-renders so a playing video survives a thread refresh.
  const mediaEls = new Map();
  function attachmentEl(a) {
    const src = '/api/attachments/' + encodeURIComponent(a.id);
    if (a.kind === 'video') {
      const stills = a.frames ? `${a.frameCount} stills for the first mate` : 'no stills';
      return h('figure', { class: 'att-video' },
        h('video', { src, controls: true, preload: 'metadata', playsinline: true, onloadedmetadata: mediaLoaded }),
        h('figcaption', { title: a.path || '' }, a.name, ' · ', stills));
    }
    return h('button', { class: 'att-img', type: 'button', title: `${a.name} (click to enlarge)`, onclick: () => openLightbox(src, a.name) },
      h('img', { src, alt: a.name, loading: 'lazy', onload: mediaLoaded }));
  }
  function attachmentsBlock(list) {
    if (!list || !list.length) return null;
    return h('div', { class: 'atts' }, list.map((a) => {
      if (!mediaEls.has(a.id)) mediaEls.set(a.id, attachmentEl(a));
      return mediaEls.get(a.id);
    }));
  }
  let lightboxBack = null;
  function openLightbox(src, name) {
    lightboxBack = document.activeElement;
    ui.lightboxImg.src = src;
    ui.lightboxImg.alt = name;
    ui.lightboxCap.textContent = name;
    ui.lightbox.hidden = false;
    ui.lightboxClose.focus();
  }
  function closeLightbox() {
    ui.lightbox.hidden = true;
    ui.lightboxImg.removeAttribute('src');
    if (lightboxBack && lightboxBack.isConnected) lightboxBack.focus({ preventScroll: true });
  }
  ui.lightbox.addEventListener('click', (e) => { if (e.target !== ui.lightboxImg) closeLightbox(); });

  ui.attachBtn.addEventListener('click', () => ui.attachInput.click());
  ui.attachInput.addEventListener('change', () => { addFiles([...ui.attachInput.files]); ui.attachInput.value = ''; });
  ui.chatText.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files, true);
  });
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  ui.panes.bridge.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; ui.panes.bridge.classList.add('dropping'); } });
  ui.panes.bridge.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui.panes.bridge.classList.remove('dropping'); } });
  ui.panes.bridge.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  ui.panes.bridge.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    ui.panes.bridge.classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });

  persist(ui.chatText, 'chat');
  ui.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  ui.chatText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey) { e.preventDefault(); sendChat(); }
  });

  // ---------- notifications ----------
  const canNotify = 'Notification' in window;
  function renderNotifyBtn() {
    if (!canNotify) { ui.notifyBtn.textContent = 'Alerts unavailable'; ui.notifyBtn.disabled = true; return; }
    const p = Notification.permission;
    ui.notifyBtn.textContent = p === 'granted' ? 'Alerts on' : p === 'denied' ? 'Alerts blocked' : 'Enable alerts';
    ui.notifyBtn.setAttribute('aria-pressed', p === 'granted' ? 'true' : 'false');
    ui.notifyBtn.title = p === 'denied' ? 'Notifications are blocked for this site in the browser settings' : 'Browser notifications for new replies and items needing the captain';
  }
  ui.notifyBtn.addEventListener('click', async () => {
    if (!canNotify) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    } else if (Notification.permission === 'granted') {
      notify('Ship Deck alerts are on', 'You will be told about new first mate replies and new items needing the captain.', 'shipdeck-test');
    }
    renderNotifyBtn();
  });
  function notify(title, body, tag, onclick) {
    if (!canNotify || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body: excerpt(body, 180), tag, icon: 'favicon.svg' });
      n.onclick = () => { window.focus(); if (onclick) onclick(); n.close(); };
    } catch { /* some browsers only allow service-worker notifications */ }
  }
  // New replies since the last one notified; the first load only sets the mark.
  function notifyReplies() {
    const last = lastReplyId();
    if (!last) return;
    const mark = store.get('notifiedReply');
    if (mark === null) { store.set('notifiedReply', last); return; }
    const fresh = thread.filter((x) => x.type === 'reply' && x.id > mark);
    if (!fresh.length) return;
    store.set('notifiedReply', last);
    if (!document.hidden && activeTab === 'bridge') return;
    const r = fresh[fresh.length - 1];
    notify(fresh.length > 1 ? `First mate (${fresh.length} new)` : 'First mate', r.text, 'shipdeck-reply', () => showTab('bridge'));
  }
  // New "needs the captain" items: crew entering decision/blocked/failed, or new Captain's Calls.
  function notifyNeeds() {
    const now = [
      ...needsCaptain().map((t) => ({ key: `t:${t.id}:${t.state}:${t.statusCount}`, title: `${t.id} needs the captain`, body: lastNote(t), open: () => openDrawer({ type: 'task', id: t.id }) })),
      ...(snap.backlog.calls || []).filter((b) => b.id).map((b) => ({ key: `c:${b.id}`, title: `Captain's Call: ${b.id}`, body: b.title, open: () => openDrawer({ type: 'backlog', id: b.id, section: b.section, index: b.index }) })),
    ];
    const seen = store.json('seenNeeds', null);
    store.set('seenNeeds', JSON.stringify(now.map((x) => x.key)));
    if (!seen) return;
    const fresh = now.filter((x) => !seen.includes(x.key));
    if (!fresh.length) return;
    toast(fresh.length > 1 ? `${fresh.length} new items need the captain` : fresh[0].title, 'ok');
    if (fresh.length === 1) notify(fresh[0].title, fresh[0].body, 'shipdeck-needs', fresh[0].open);
    else notify(`${fresh.length} new items need the captain`, fresh.map((x) => x.title).join('\n'), 'shipdeck-needs', () => showTab('command'));
  }

  // ---------- sessions ----------
  let sessionsAt = 0;
  let sessionEntries = null;
  async function loadSessions(force) {
    if (!force && Date.now() - sessionsAt < 15000) return;
    sessionsAt = Date.now();
    try {
      const res = await fetch('/api/sessions', { cache: 'no-store' });
      sessionEntries = (await res.json()).entries || [];
    } catch {
      if (!sessionEntries) sessionEntries = [];
    }
    renderSessions();
  }
  function renderSessions() {
    if (!sessionEntries) return;
    const q = ui.sessionsFilter.value.trim().toLowerCase();
    const list = sessionEntries.filter((e) => !q || [e.id, e.cwd, e.sessionId, e.harness, e.firstmate && 'first mate'].join(' ').toLowerCase().includes(q));
    if (unchanged('sessions', list, q)) return;
    ui.sessionsList.replaceChildren(...(list.length ? list.map((e) => {
      const name = e.firstmate ? 'First mate' : e.id;
      const tag = e.firstmate ? 'helm' : e.present ? 'aboard' : 'departed';
      return h('li', { class: 'session' + (e.present ? '' : ' departed') },
        h('div', { class: 'session-head' },
          e.present && !e.firstmate
            ? h('button', { class: 'linkish mono', type: 'button', text: name, onclick: () => openDrawer({ type: 'task', id: e.id }) })
            : h('span', { class: 'mono strong', text: name }),
          h('span', { class: 'tag tag-' + tag, text: tag }),
          h('span', { class: 'r-age', text: e.lastSeen ? `seen ${ago(e.lastSeen)}` : '' })),
        resumeBlock(e));
    }) : [emptyRow(sessionEntries.length ? 'No sessions match.' : 'No sessions recorded yet. Ship Deck records Claude Code sessions as it finds them.')]));
  }
  ui.sessionsFilter.addEventListener('input', renderSessions);

  // ---------- wiring ----------
  function renderAll() {
    if (!snap) return;
    ui.home.textContent = snap.home;
    renderBridge();
    renderDeck();
    renderCabins();
    renderHold();
    renderPanel();
    renderDrawer();
    firstRender = false;
  }

  function setSync(ok, text) {
    ui.sync.classList.toggle('ok', ok);
    ui.sync.classList.toggle('err', !ok);
    ui.syncText.textContent = text;
    if (ok) { ui.sync.classList.remove('tick'); void ui.sync.offsetWidth; ui.sync.classList.add('tick'); }
  }

  // Polls every POLL_MS; after a failure it backs off up to 15 s and shows the banner.
  let timer = null;
  let failures = 0;
  let countdown = null;
  function showReconnect(delay) {
    ui.reconnect.hidden = false;
    let left = Math.round(delay / 1000);
    clearInterval(countdown);
    const tick = () => { ui.reconnectText.textContent = `Ship Deck server unreachable. Reconnecting in ${left}s…`; left = Math.max(0, left - 1); };
    tick();
    countdown = setInterval(tick, 1000);
  }
  async function poll() {
    clearTimeout(timer);
    let delay = POLL_MS;
    try {
      const res = await fetch('/api/fleet', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      snap = await res.json();
      lastOkAt = Date.now();
      if (failures) { toast('Reconnected to the Ship Deck server', 'ok'); ui.reconnect.hidden = true; clearInterval(countdown); }
      failures = 0;
      renderAll();
      setSync(true, `Live · ${new Date(lastOkAt).toLocaleTimeString()}`);
      if (snap.thread && snap.thread.sig !== threadSig) loadThread(snap.thread.sig);
      notifyNeeds();
      if (activeTab === 'sessions') loadSessions(false);
      loadActivity();
      if (firstHash) { const id = firstHash; firstHash = null; if (snap.tasks.some((t) => t.id === id)) openDrawer({ type: 'task', id }); }
    } catch (e) {
      failures++;
      delay = Math.min(15000, POLL_MS * Math.pow(1.6, failures - 1));
      setSync(false, lastOkAt ? `Offline · last ${new Date(lastOkAt).toLocaleTimeString()}` : 'Cannot reach server');
      showReconnect(delay);
    }
    timer = setTimeout(poll, delay);
  }
  ui.reconnectNow.addEventListener('click', () => { ui.reconnectText.textContent = 'Reconnecting…'; poll(); });

  let firstHash = (/^#task=(.+)$/.exec(location.hash) || [])[1];
  if (firstHash) firstHash = decodeURIComponent(firstHash);

  ui.search.addEventListener('input', () => { query = ui.search.value.trim().toLowerCase(); renderAll(); });
  const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !editable(document.activeElement) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (!ui.library.hidden) { ui.libraryFilter.focus(); ui.libraryFilter.select(); } else { ui.search.focus(); ui.search.select(); }
    } else if (e.key === 'Escape') {
      if (!ui.lightbox.hidden) closeLightbox();
      else if (confirmResolve) confirmResolve(false);
      else if (!ui.library.hidden) closeLibrary();
      else if (selected && closeDataFile()) { /* back to the crew details */ }
      else if (selected) closeDrawer();
      else if (document.activeElement === ui.search && ui.search.value) { ui.search.value = ''; query = ''; renderAll(); }
      else if (stateFilter) { stateFilter = null; renderAll(); }
    } else if (e.key === 'Enter' && confirmResolve && !editable(document.activeElement) && document.activeElement !== ui.confirmNo) {
      e.preventDefault();
      confirmResolve(true);
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); refreshPeek(); markSeen(); } });

  // ---------- ship's library (read-only) ----------
  let libEntries = [];
  let libKey = null;

  function renderLibraryList() {
    const q = ui.libraryFilter.value.trim().toLowerCase();
    const shown = libEntries.filter((e) => !q || [e.group, e.label, e.description].join(' ').toLowerCase().includes(q));
    const groups = [];
    for (const e of shown) {
      let g = groups.find((x) => x.name === e.group);
      if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
      g.items.push(e);
    }
    ui.libraryList.replaceChildren(...(groups.length ? groups.map((g) => h('div', { class: 'lib-group' },
      h('h3', null, g.name, h('span', { class: 'lib-count', text: g.items.length })),
      h('ul', { class: 'lib-items' }, ...g.items.map((e) => h('li', null, h('button', {
        class: 'lib-item' + (e.exists ? '' : ' missing') + (e.key === libKey ? ' active' : '') + (e.description !== undefined ? ' skill' : ''), type: 'button',
        'aria-current': e.key === libKey ? 'true' : null, title: e.description || e.path,
        onclick: () => openLibraryEntry(e.key),
      }, h('span', { class: 'lib-line' }, h('span', { class: 'lib-name', text: e.label }), h('span', { class: 'lib-age', text: e.exists ? ago(e.mtime) : 'missing' })),
      e.description ? h('span', { class: 'lib-desc', text: e.description }) : null)))))) : [h('p', { class: 'empty', text: 'No files match.' })]));
  }
  async function openLibraryEntry(key) {
    libKey = key;
    renderLibraryList();
    ui.libraryDoc.replaceChildren(h('p', { class: 'empty', text: 'Loading…' }));
    try {
      const res = await fetch('/api/library/file?key=' + encodeURIComponent(key), { cache: 'no-store' });
      const body = await res.json();
      if (libKey !== key) return;
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      const e = body.entry;
      const isSkill = e.description !== undefined;
      const head = h('header', { class: 'doc-head' },
        h('p', { class: 'doc-kicker', text: e.group }),
        h('h2', { class: 'mono', text: e.label }),
        isSkill && e.description ? h('p', { class: 'doc-desc', text: e.description }) : null,
        h('p', { class: 'doc-meta', text: e.exists
          ? `${e.path} · modified ${agoLong(e.mtime)} (${stamp(e.mtime)}) · ${(e.size / 1024).toFixed(1)} KB${body.truncated ? ' · truncated' : ''}`
          : e.path }));
      if (body.text === null) {
        ui.libraryDoc.replaceChildren(head, h('div', { class: 'doc-missing' }, h('strong', { text: 'Missing' }), h('span', { text: 'This file does not exist (yet). Nothing to show.' })));
      } else {
        const md = h('div', { class: 'md' });
        md.innerHTML = MD.render(body.text, { frontmatter: isSkill ? 'hide' : 'show' }); // escaped by the renderer
        ui.libraryDoc.replaceChildren(head, md);
      }
      ui.libraryDoc.scrollTop = 0;
    } catch (err) {
      ui.libraryDoc.replaceChildren(h('p', { class: 'empty', text: `Could not open: ${err.message}` }));
    }
  }
  async function openLibrary() {
    ui.library.hidden = false;
    ui.libraryScrim.hidden = false;
    ui.libraryFilter.focus();
    try {
      const res = await fetch('/api/library', { cache: 'no-store' });
      libEntries = (await res.json()).entries || [];
    } catch {
      libEntries = [];
    }
    renderLibraryList();
    const first = libEntries.find((e) => e.key === libKey) || libEntries.find((e) => e.exists);
    if (first) openLibraryEntry(first.key);
    else ui.libraryDoc.replaceChildren(h('p', { class: 'empty', text: 'The library is empty.' }));
  }
  function closeLibrary() {
    ui.library.hidden = true;
    ui.libraryScrim.hidden = true;
    ui.libraryBtn.focus();
  }
  ui.libraryBtn.addEventListener('click', openLibrary);
  ui.libraryClose.addEventListener('click', closeLibrary);
  ui.libraryScrim.addEventListener('click', closeLibrary);
  ui.libraryFilter.addEventListener('input', renderLibraryList);

  // Bridge avatar, notifications button, remembered tab, then the first poll.
  document.querySelectorAll('.fm-avatar .sailor').forEach((s) => { s.innerHTML = SAILOR; });
  renderNotifyBtn();
  showTab(store.get('tab', 'bridge'));
  poll();
})();
