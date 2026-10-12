'use strict';
// Ship Deck frontend: polls /api/fleet and reconciles the deck in place.

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

  const $ = (id) => document.getElementById(id);
  const ui = {
    home: $('home-path'), search: $('search'), sync: $('sync'), syncText: $('sync-text'),
    captain: $('captain'), awaySign: $('away-sign'), lamp: $('lamp'), lampLabel: $('lamp-label'), wheel: $('wheel'),
    areas: $('areas'), cabins: $('cabins'), cabinRow: $('cabin-row'),
    hold: $('hold'), holdSub: $('hold-sub'), crates: $('crates'),
    watch: $('watch-card'), counts: $('counts'),
    needsCount: $('needs-count'), needsList: $('needs-list'),
    callsWrap: $('calls-wrap'), callsCount: $('calls-count'), callsList: $('calls-list'),
    doneList: $('done-list'), prList: $('pr-list'),
    drawer: $('drawer'), scrim: $('scrim'), drawerKicker: $('drawer-kicker'), drawerTitle: $('drawer-title'),
    drawerBody: $('drawer-body'), drawerClose: $('drawer-close'),
    ordersCount: $('orders-count'), ordersList: $('orders-list'), orderForm: $('order-form'), orderText: $('order-text'),
    libraryBtn: $('library-btn'), library: $('library'), libraryScrim: $('library-scrim'), libraryClose: $('library-close'),
    libraryFilter: $('library-filter'), libraryList: $('library-list'), libraryDoc: $('library-doc'),
    toasts: $('toasts'),
  };

  let snap = null;
  let query = '';
  let stateFilter = null;
  let selected = null; // { type: 'task' | 'backlog', id }
  let lastOkAt = 0;
  const stations = new Map(); // id -> element
  const areaEls = new Map(); // projectKey -> { root, plaque, tally, grid }
  const prevState = new Map();
  let firstRender = true;

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

  // ---------- command center ----------
  function listRow(t, note, onclick) {
    return h('li', null, h('button', { class: 'row', type: 'button', onclick, style: `--c:${stateVar(bucket(t))}` },
      h('span', { class: 'dot' }), h('span', { class: 'r-id', text: t.id, title: t.id }), h('span', { class: 'r-age', text: ago(t.lastActivity) }),
      note ? h('span', { class: 'r-note', text: note }) : null));
  }
  function emptyRow(text) { return h('li', null, h('div', { class: 'empty', text })); }

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

    const needs = snap.tasks.filter((t) => ATTENTION.has(t.state) && !t.stale).sort(sortTasks);
    const calls = [...snap.backlog.captain, ...snap.backlog.inFlight, ...snap.backlog.queued].filter((b) => b.captainCall);
    const sigOf = (list) => list.map((t) => [t.id, t.state, t.stale, ago(t.lastActivity), lastNote(t)]);
    ui.needsCount.textContent = needs.length;
    ui.needsCount.classList.toggle('zero', needs.length === 0);
    if (!unchanged('needs', sigOf(needs))) ui.needsList.replaceChildren(...(needs.length
      ? needs.map((t) => listRow(t, lastNote(t), () => openDrawer({ type: 'task', id: t.id })))
      : [emptyRow('No crew waiting on the captain.')]));
    ui.callsCount.textContent = calls.length;
    ui.callsWrap.hidden = calls.length === 0;
    if (!unchanged('calls', calls)) ui.callsList.replaceChildren(...calls.map((b) => {
      const section = snap.backlog.captain.includes(b) ? 'captain' : snap.backlog.inFlight.includes(b) ? 'inFlight' : 'queued';
      const index = snap.backlog[section].indexOf(b);
      return h('li', null, h('button', {
        class: 'row', type: 'button', style: `--c:${stateVar('needs-decision')}`,
        onclick: () => openDrawer({ type: 'backlog', id: b.id || b.title, section, index }),
      }, h('span', { class: 'dot' }), h('span', { class: 'r-id', text: b.id || '(untitled)', title: b.id || '' }),
      h('span', { class: 'r-age', text: (b.tags && b.tags.since) || '' }), h('span', { class: 'r-note', text: b.title })));
    }));

    const done = snap.tasks.filter((t) => t.state === 'done').sort((a, b) => (b.statusMtime || 0) - (a.statusMtime || 0)).slice(0, 6);
    if (!unchanged('done', sigOf(done))) ui.doneList.replaceChildren(...(done.length
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
      ? ord.list.slice(0, 12).map(orderRow)
      : [emptyRow('No orders yet.')]));
  }

  const ORDER_COLOR = { pending: 'needs-decision', acknowledged: 'working', done: 'done', declined: 'failed' };
  function orderRow(o) {
    const when = o.ts ? Date.parse(o.ts) : null;
    const inner = [
      h('span', { class: 'dot' }),
      h('span', { class: 'r-id' }, h('span', { class: 'o-kind', text: KIND_LABEL[o.kind] || o.kind }), o.target ? ' ' + o.target : ''),
      h('span', { class: 'r-age' }, h('span', { class: 'o-status', text: o.status }), ' ', ago(when)),
      h('span', { class: 'r-note', text: o.text }),
      o.note ? h('span', { class: 'r-note o-note', text: `↳ ${o.note}` }) : null,
    ];
    const title = `${o.id}\n${o.status}${o.ackTs ? ' · ' + o.ackTs : ''}\nqueued ${o.ts}`;
    const attrs = { class: 'row' + (o.pending ? ' pending' : ''), style: `--c:${stateVar(ORDER_COLOR[o.status] || 'unknown')}`, title };
    return h('li', null, o.target && snap.tasks.some((t) => t.id === o.target)
      ? h('button', { ...attrs, type: 'button', onclick: () => openDrawer({ type: 'task', id: o.target }) }, ...inner)
      : h('div', attrs, ...inner));
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
  }

  // The task drawer keeps its interactive parts (pane peek, message box, order
  // buttons, file viewer) across polls; only the facts are rebuilt each tick.
  let td = null; // { id, root, info, orders, peek, file, ... }

  function renderTaskDrawer() {
    const t = snap.tasks.find((x) => x.id === selected.id);
    if (!t) {
      stopPeek();
      td = null;
      ui.drawerKicker.replaceChildren('Left the ship');
      ui.drawerTitle.textContent = selected.id;
      ui.drawerBody.replaceChildren(h('p', { text: 'This task no longer has a meta file in state/. It was probably torn down.' }));
      return;
    }
    ui.drawerKicker.replaceChildren(...[h('span', { class: 'pill', style: `background:${stateVar(t.state)}`, text: STATE_LABEL[t.state] }),
      t.stale ? h('span', { class: 'pill', style: `background:${stateVar('stale')}`, text: 'stale' }) : null, t.kind].filter(Boolean));
    ui.drawerTitle.textContent = t.id;
    if (!td || td.id !== t.id || !td.root.isConnected) buildTaskDrawer(t);
    td.task = t;
    if (!unchanged('drawer-info', t, snap.tmux.available)) td.info.replaceChildren(...taskInfo(t));
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
    if (t.worktree) links.append(h('button', {
      class: 'link-btn copy', type: 'button', text: 'Copy worktree path',
      onclick: (e) => { navigator.clipboard && navigator.clipboard.writeText(t.worktree).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy worktree path'; }, 1200); }); },
    }));
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

    // Orders to the first mate about this worker.
    const answerText = h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Your answer to its decision…', 'aria-label': `Answer for ${id}` });
    const answerRow = h('div', { class: 'answer-row', hidden: true }, answerText,
      h('div', { class: 'btn-row' },
        h('button', { class: 'act-btn primary', type: 'button', text: 'Queue answer', onclick: async () => {
          if (!answerText.value.trim()) { answerText.focus(); return; }
          if (await queueOrder({ kind: 'answer', target: id, text: answerText.value })) { answerText.value = ''; answerRow.hidden = true; }
        } }),
        h('button', { class: 'act-btn', type: 'button', text: 'Cancel', onclick: () => { answerRow.hidden = true; } })));
    d.mergeBtn = h('button', { class: 'act-btn', type: 'button', text: 'Merge its PR', onclick: () => queueOrder({ kind: 'merge', target: id }) });
    d.ordersList = h('ul', { class: 'list orders compact' });
    const ordersSec = h('section', { class: 'drawer-sec' },
      h('h3', { text: 'Orders to the first mate' }),
      h('p', { class: 'hint', text: 'Queued for the first mate to act on; Ship Deck does not run them.' }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'act-btn', type: 'button', text: 'Clean up this worker', onclick: () => queueOrder({ kind: 'cleanup', target: id }) }),
        d.mergeBtn,
        h('button', { class: 'act-btn', type: 'button', text: 'Answer decision…', onclick: () => { answerRow.hidden = false; answerText.focus(); } }),
        h('button', { class: 'act-btn', type: 'button', text: 'Ask for status', onclick: () => queueOrder({ kind: 'status', target: id }) })),
      answerRow,
      d.ordersList);

    // Message the worker directly (fm-send), with a confirmation step.
    const msg = h('input', { type: 'text', maxlength: '2000', placeholder: 'Message to this worker (one line)…', 'aria-label': `Message to ${id}`, autocomplete: 'off' });
    const sendBtn = h('button', { class: 'act-btn primary', type: 'submit', text: 'Send' });
    const confirmText = h('span');
    const confirmYes = h('button', { class: 'act-btn danger', type: 'button', text: 'Send now' });
    const confirmNo = h('button', { class: 'act-btn', type: 'button', text: 'Cancel' });
    const confirmRow = h('div', { class: 'confirm-row', hidden: true, role: 'alert' }, confirmText, confirmYes, confirmNo);
    const form = h('form', { class: 'msg-form' }, msg, sendBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = msg.value.replace(/\s+/g, ' ').trim();
      if (!text) { msg.focus(); return; }
      confirmText.textContent = `Send to ${id}?`;
      confirmRow.hidden = false;
      confirmYes.focus();
    });
    confirmNo.addEventListener('click', () => { confirmRow.hidden = true; msg.focus(); });
    confirmYes.addEventListener('click', async () => {
      confirmRow.hidden = true;
      sendBtn.disabled = true;
      const text = msg.value.replace(/\s+/g, ' ').trim();
      const r = await post('/api/send', { id, message: text });
      sendBtn.disabled = false;
      if (r.ok) { msg.value = ''; toast(`Sent to ${id}`, 'ok'); setTimeout(refreshPeek, 600); }
      else toast(`Send to ${id} failed: ${r.error || 'unknown error'}`, 'err');
    });
    d.msgWrap = h('section', { class: 'drawer-sec' },
      h('h3', { text: 'Message the worker' }),
      h('p', { class: 'hint', text: 'Types one line into its tmux window via fm-send. Use sparingly: it bypasses the first mate.' }),
      form, confirmRow);

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

    d.root = h('div', { class: 'task-drawer' }, d.file, d.info, d.peekWrap, d.msgWrap, ordersSec);
    ui.drawerBody.replaceChildren(d.root);
    ui.drawerBody.scrollTop = 0;
    sigs.delete('drawer-info');
    sigs.delete('drawer-orders');
    td = d;
    if (t.window) startPeek();
  }

  function renderTaskOrders(t) {
    const mine = ((snap.orders && snap.orders.list) || []).filter((o) => o.target === t.id);
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

  // ---------- actions ----------
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
      return { ok: false, error: 'cannot reach the server' };
    }
  }
  const KIND_LABEL = { cleanup: 'Clean up', merge: 'Merge PR', answer: 'Answer', status: 'Status?', order: 'Order' };
  async function queueOrder(req) {
    const r = await post('/api/orders', req);
    if (r.ok) {
      toast(`Order queued for the first mate: ${KIND_LABEL[req.kind] || req.kind}${req.target ? ' · ' + req.target : ''}`, 'ok');
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

  function backlogItem() {
    const list = snap.backlog[selected.section] || [];
    const byIndex = list[selected.index];
    if (byIndex && (byIndex.id || byIndex.title) === selected.id) return byIndex;
    return list.find((b) => (b.id || b.title) === selected.id);
  }

  function renderBacklogDrawer() {
    const b = backlogItem();
    const sectionName = { captain: "Captain's Call", inFlight: 'In flight', queued: 'Queued', done: 'Done' }[selected.section] || 'Backlog';
    ui.drawerKicker.replaceChildren(`Backlog · ${sectionName}`);
    ui.drawerTitle.textContent = selected.id;
    if (!b) { ui.drawerBody.replaceChildren(h('p', { text: 'This backlog item is no longer listed.' })); return; }
    const kids = [h('p', { class: 'brief', text: b.title })];
    const dl = h('dl', { class: 'facts' });
    if (b.captainCall) fact(dl, 'Needs', 'captain decision');
    for (const [k, v] of Object.entries(b.tags || {})) fact(dl, k, v.length > 400 ? v.slice(0, 400) + '…' : v);
    kids.push(dl);
    if (b.notes.length) kids.push(h('h3', { text: 'Notes' }), h('pre', { class: 'notes-block', text: b.notes.join('\n') }));
    ui.drawerBody.replaceChildren(...kids);
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

  function openDrawer(sel) {
    if (!selected || selected.type !== sel.type || selected.id !== sel.id) { stopPeek(); td = null; }
    selected = sel;
    ui.drawer.classList.add('open');
    ui.drawer.setAttribute('aria-hidden', 'false');
    ui.scrim.hidden = false;
    renderDrawer();
    for (const [id, el] of stations) el.classList.toggle('selected', sel.type === 'task' && sel.id === id);
    const want = sel.type === 'task' ? `#task=${encodeURIComponent(sel.id)}` : '';
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
    ui.drawer.focus({ preventScroll: true });
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

  let timer = null;
  async function poll() {
    clearTimeout(timer);
    try {
      const res = await fetch('/api/fleet', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      snap = await res.json();
      lastOkAt = Date.now();
      renderAll();
      setSync(true, `Live · ${new Date(lastOkAt).toLocaleTimeString()}`);
      if (firstHash) { const id = firstHash; firstHash = null; if (snap.tasks.some((t) => t.id === id)) openDrawer({ type: 'task', id }); }
    } catch (e) {
      setSync(false, lastOkAt ? `Offline · last ${new Date(lastOkAt).toLocaleTimeString()}` : 'Cannot reach server');
    }
    timer = setTimeout(poll, POLL_MS);
  }

  let firstHash = (/^#task=(.+)$/.exec(location.hash) || [])[1];
  if (firstHash) firstHash = decodeURIComponent(firstHash);

  ui.search.addEventListener('input', () => { query = ui.search.value.trim().toLowerCase(); renderAll(); });
  const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !editable(document.activeElement) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (!ui.library.hidden) { ui.libraryFilter.focus(); ui.libraryFilter.select(); } else { ui.search.focus(); ui.search.select(); }
    } else if (e.key === 'Escape') {
      if (!ui.library.hidden) closeLibrary();
      else if (selected && closeDataFile()) { /* back to the crew details */ }
      else if (selected) closeDrawer();
      else if (document.activeElement === ui.search && ui.search.value) { ui.search.value = ''; query = ''; renderAll(); }
      else if (stateFilter) { stateFilter = null; renderAll(); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); refreshPeek(); } });

  ui.orderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ui.orderText.value.trim();
    if (!text) { ui.orderText.focus(); return; }
    if (await queueOrder({ kind: 'order', text })) ui.orderText.value = '';
  });
  ui.orderText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ui.orderForm.requestSubmit(); }
  });

  // ---------- ship's library (read-only) ----------
  let libEntries = [];
  let libKey = null;
  function mdEscape(s) {
    return s.replace(/\u0000/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Inline markdown on already-escaped text. Code spans and links are held out
  // as placeholders so emphasis never lands inside them; links only for http(s).
  function mdInline(s) {
    const held = [];
    const hold = (html) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
    const link = (u, t) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => pre + link(u, u));
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
    for (let i = 0; i < 3 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[n]);
    return s;
  }
  // Small, safe markdown renderer: every source character is HTML-escaped first.
  function renderMarkdown(src) {
    const lines = mdEscape(String(src)).split(/\r?\n/);
    const out = [];
    let para = [];
    let list = null; // 'ul' | 'ol'
    const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)/.exec(line);
      if (fence) {
        flushPara(); flushList();
        const body = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
        out.push(`<pre><code>${body.join('\n')}</code></pre>`);
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushPara(); flushList(); const n = Math.min(6, m[1].length + 1); out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if ((m = /^\s*&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<blockquote>${mdInline(m[1])}</blockquote>`); continue; }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        flushPara();
        const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
        if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
        const indent = Math.min(4, Math.floor(m[1].length / 2));
        let item = m[3];
        const box = /^\[([ xX])\]\s+(.*)$/.exec(item);
        if (box) item = `<span class="md-box">${box[1].trim() ? '☑' : '☐'}</span> ${box[2]}`;
        out.push(`<li${indent ? ` style="margin-left:${indent * 1.2}em"` : ''}>${mdInline(item)}</li>`);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${mdInline(line.trim())}</li>`); continue; }
      flushList();
      para.push(line.trim());
    }
    flushPara(); flushList();
    return out.join('\n');
  }

  function renderLibraryList() {
    const q = ui.libraryFilter.value.trim().toLowerCase();
    const shown = libEntries.filter((e) => !q || (e.group + ' ' + e.label).toLowerCase().includes(q));
    const groups = [];
    for (const e of shown) {
      let g = groups.find((x) => x.name === e.group);
      if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
      g.items.push(e);
    }
    ui.libraryList.replaceChildren(...(groups.length ? groups.map((g) => h('div', { class: 'lib-group' },
      h('h3', { text: g.name }),
      h('ul', { class: 'lib-items' }, ...g.items.map((e) => h('li', null, h('button', {
        class: 'lib-item' + (e.exists ? '' : ' missing') + (e.key === libKey ? ' active' : ''), type: 'button',
        'aria-current': e.key === libKey ? 'true' : null, title: e.path,
        onclick: () => openLibraryEntry(e.key),
      }, h('span', { class: 'lib-name', text: e.label }), h('span', { class: 'lib-age', text: e.exists ? ago(e.mtime) : 'missing' }))))))) : [h('p', { class: 'empty', text: 'No files match.' })]));
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
      const head = h('header', { class: 'doc-head' },
        h('h2', { class: 'mono', text: e.label }),
        h('p', { class: 'doc-meta', text: e.exists
          ? `${e.path} · modified ${agoLong(e.mtime)} (${stamp(e.mtime)}) · ${(e.size / 1024).toFixed(1)} KB${body.truncated ? ' · truncated' : ''}`
          : e.path }));
      if (body.text === null) {
        ui.libraryDoc.replaceChildren(head, h('div', { class: 'doc-missing' }, h('strong', { text: 'Missing' }), h('span', { text: 'This file does not exist (yet). Nothing to show.' })));
      } else {
        const md = h('div', { class: 'md' });
        md.innerHTML = renderMarkdown(body.text); // escaped by renderMarkdown
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

  poll();
})();
