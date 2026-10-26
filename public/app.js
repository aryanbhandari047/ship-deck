'use strict';
// Ship Deck frontend: polls /api/fleet, renders the Board (default) or the Ship view in
// place, and runs the captain's control surface (chat, orders, drawers, library).

(() => {
  const POLL_MS = 3000;
  const STATE_ORDER = ['needs-decision', 'blocked', 'failed', 'working', 'paused', 'unknown', 'done'];
  const ATTENTION = new Set(['needs-decision', 'blocked', 'failed']);
  const L = window.ShipDeckLabels;
  const STATE_LABEL = L.STATE_LABEL;
  const MAX_CRATES = 48;
  const LISTENING_MS = 2 * 60 * 1000; // first mate activity this recent = listening
  const MD = window.ShipDeckMarkdown;
  const B = window.ShipDeckBoard;

  const $ = (id) => document.getElementById(id);
  const ui = {
    home: $('home-path'), search: $('search'), sync: $('sync'), syncText: $('sync-text'),
    healthFm: $('health-fm'), healthMon: $('health-mon'), healthTime: $('health-time'),
    firstRun: $('first-run'), firstRunChecked: $('first-run-checked'), captainName: $('captain-name'),
    reconnect: $('reconnect'), reconnectText: $('reconnect-text'), reconnectNow: $('reconnect-now'),
    captain: $('captain'), captainState: $('captain-state'), firstmate: $('firstmate'), fmShipNow: $('fm-ship-now'), lamp: $('lamp'), lampLabel: $('lamp-label'), legend: $('legend'),
    areas: $('areas'), cabins: $('cabins'), cabinRow: $('cabin-row'),
    hold: $('hold'), holdSub: $('hold-sub'), crates: $('crates'),
    tabs: { bridge: $('tab-bridge'), activity: $('tab-activity') },
    panes: { bridge: $('pane-bridge'), activity: $('pane-activity') },
    board: $('board'), scene: $('scene'), cols: $('cols'), mates: $('mates'), projectFilters: $('project-filters'), boardTitle: $('board-title'),
    viewBoard: $('view-board'), viewShip: $('view-ship'), chatJump: $('chat-jump'),
    fmWho: $('fm-who'), fmLive: $('fm-live'), fmNowText: $('fm-now-text'),
    newJobBtn: $('new-job-btn'), jobSheet: $('job-sheet'), jobScrim: $('job-scrim'), jobClose: $('job-close'), jobCancel: $('job-cancel'),
    layout: document.querySelector('.layout'), panel: $('panel'), panelResize: $('panel-resize'),
    feed: $('feed'), activitySub: $('activity-sub'), activityDot: $('activity-dot'),
    unread: $('unread-count'), workingNow: $('working-now'), workingNowText: $('working-now-text'), suggest: $('suggest'),
    thread: $('thread'), threadJump: $('thread-jump'), chatForm: $('chat-form'), chatText: $('chat-text'), chatSend: $('chat-send'),
    notifyBtn: $('notify-btn'), bridgeSub: $('bridge-sub'), chatHint: $('chat-hint'),
    attTray: $('att-tray'), attachBtn: $('attach-btn'), attachInput: $('attach-input'),
    lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxCap: $('lightbox-cap'), lightboxClose: $('lightbox-close'),
    jobForm: $('job-form'), jobProject: $('job-project'), jobText: $('job-text'),
    jobHarness: $('job-harness'), jobModel: $('job-model'), jobEffort: $('job-effort'),
    drawer: $('drawer'), scrim: $('scrim'), drawerKicker: $('drawer-kicker'), drawerTitle: $('drawer-title'),
    drawerBody: $('drawer-body'), drawerClose: $('drawer-close'), drawerSub: $('drawer-sub'),
    libraryBtn: $('library-btn'), library: $('library'), libraryScrim: $('library-scrim'), libraryClose: $('library-close'),
    libraryFilter: $('library-filter'), libraryList: $('library-list'), libraryDoc: $('library-doc'),
    confirm: $('confirm'), confirmScrim: $('confirm-scrim'), confirmTitle: $('confirm-title'), confirmBody: $('confirm-body'),
    confirmWarn: $('confirm-warn'), confirmYes: $('confirm-yes'), confirmNo: $('confirm-no'),
    toasts: $('toasts'), helpBtn: $('help-btn'), shortcuts: $('shortcuts'), shortcutsScrim: $('shortcuts-scrim'), shortcutsClose: $('shortcuts-close'), shortcutsBody: $('shortcuts-body'),
  };

  let snap = null;
  let query = '';
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

  // "2026-01-05 09:12" (local time, as written in status logs) -> ms, or null.
  function localTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : null;
  }
  // One timestamp format everywhere: "Today 12:15", "Yesterday 09:12", "5 Jan 10:40", "5 Jan 2025 10:40".
  function whenText(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today ${hm}`;
    if (d.toDateString() === new Date(now - 86400000).toDateString()) return `Yesterday ${hm}`;
    const day = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    return `${day} ${hm}`;
  }
  // Inline SVG from the sprite in index.html: line icons (#i-*) and status flags (#flag-*).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(id, cls) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', cls || 'ico');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  }
  function flagEl(flag, cls) { return icon('flag-' + flag, 'flag' + (cls ? ' ' + cls : '')); }
  // A status pill: flag + word on the tone's tinted wash. st: { tone, flag, label }.
  function pillEl(st, cls) { return h('span', { class: `pill tone-${st.tone}${cls ? ' ' + cls : ''}` }, flagEl(st.flag), st.label); }
  function taskStatus(t) { return B.statusOf(t); }
  // Only http(s) pull request links become links (a worker file could hold anything).
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? u : null);
  function prNumber(url) { const m = /\/pull\/(\d+)/.exec(url || ''); return m ? '#' + m[1] : 'PR'; }
  // Skips a DOM rebuild when its inputs are unchanged, so focus and hover survive polling.
  const sigs = new Map();
  function unchanged(name, ...parts) {
    const sig = JSON.stringify(parts);
    if (sigs.get(name) === sig) return true;
    sigs.set(name, sig);
    return false;
  }
  function staleText(t) { return `${L.quietText(t.lastActivity)} (marked quiet after ${snap.staleDays} d without activity)`; }
  // Worker title (from its queue entry or brief), falling back to the raw id.
  function titleOf(id) { const t = snap && snap.tasks.find((x) => x.id === id); return t ? t.title || t.id : id; }
  function lastNote(t) { const l = t.lastStatus[t.lastStatus.length - 1]; return l ? l.note : ''; }

  // ---------- filtering ----------
  function matchesTask(t) {
    if (!query) return true;
    const hay = [t.id, t.title, t.project, t.state, STATE_LABEL[t.state], taskStatus(t).label, B.TONES[taskStatus(t).tone].word, t.stale && 'stale quiet', t.kind, t.mode, t.brief, L.summary(t)].join(' ').toLowerCase();
    return query.split(/\s+/).every((q) => hay.includes(q));
  }
  function matchesCrate(item) {
    if (!query) return true;
    const hay = [item.id, item.title, item.tags && item.tags.repo, item.captainCall ? 'needs you question' : '', 'queued backlog queue'].join(' ').toLowerCase();
    return query.split(/\s+/).every((q) => hay.includes(q));
  }

  // ---------- ship view: the deck as a nautical chart ----------
  // Each worker is a berth flying its status flag; the flag is hoisted once when it first
  // goes up for "needs you" or "blocked". Nothing loops.
  function makeStation(t) {
    const el = h('button', { class: 'berth', type: 'button', 'data-id': t.id },
      h('span', { class: 'mast' }, h('span', { class: 'pole' }), flagEl('x')),
      icon('i-crew', 'crew'),
      h('span', { class: 't' }), h('code', { class: 'rid' }), h('span', { class: 'pill sm' }));
    el.addEventListener('click', () => openDrawer({ type: 'task', id: t.id }));
    return el;
  }
  function updateStation(el, t) {
    const st = taskStatus(t);
    const prev = el.dataset.tone;
    el.className = `berth tone-${st.tone}`;
    el.classList.toggle('needs', st.tone === 'needs' || st.tone === 'blocked');
    el.classList.toggle('is-alive', t.alive === true);
    el.classList.toggle('selected', !!selected && selected.type === 'task' && selected.id === t.id);
    el.dataset.tone = st.tone;
    if (prev && prev !== st.tone && (st.tone === 'needs' || st.tone === 'blocked')) {
      el.classList.add('hoist');
      setTimeout(() => el.classList.remove('hoist'), 2600);
    }
    el.querySelector('.mast use').setAttribute('href', '#flag-' + st.flag);
    el.querySelector('.t').textContent = t.title || t.id;
    el.querySelector('.rid').textContent = t.title && t.title !== t.id ? t.id : '';
    el.querySelector('.pill').replaceWith(pillEl(st, 'sm'));
    const alive = t.alive === true ? 'terminal open' : t.alive === false ? 'terminal closed' : '';
    el.title = `${t.title || t.id}\n${t.project}${alive ? ', ' + alive : ''}\n\n${L.summary(t)}`;
    el.setAttribute('aria-label', `${t.title || t.id}, ${t.project}: ${st.label}. ${L.summary(t)}`);
  }

  // Quiet workers sit after the active ones and before the finished ones.
  function rank(t) { return t.stale ? STATE_ORDER.indexOf('done') - 0.5 : STATE_ORDER.indexOf(t.state); }
  function sortTasks(a, b) {
    const d = rank(a) - rank(b);
    return d || a.id.localeCompare(b.id);
  }

  function makeArea(key) {
    const plaque = h('div', { class: 'zone-title' });
    const tally = h('div', { class: 'tally' });
    const grid = h('div', { class: 'berths' });
    const root = h('section', { class: 'zone', 'data-area': key }, h('div', { class: 'zone-head' }, plaque, tally), grid);
    return { root, plaque, tally, grid };
  }

  // Moves el to position i only when it is out of place: moving a node blurs it.
  function placeAt(parent, el, i) {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null);
  }
  function renderLegend() {
    if (ui.legend.childElementCount) return;
    ui.legend.replaceChildren(h('span', { class: 'legend-title', text: 'Flags' }),
      ...B.TONE_ORDER.map((tone) => h('span', { title: B.TONES[tone].meaning }, flagEl(B.TONES[tone].flag), B.TONES[tone].word)));
  }

  function renderDeck() {
    renderLegend();
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
      area.plaque.replaceChildren(...[h('h2', { text: tasks[0].project }), reg && reg.description ? h('span', { class: 'muted', text: reg.description }) : null].filter(Boolean));
      const tallies = new Map();
      for (const t of tasks) { const tone = taskStatus(t).tone; tallies.set(tone, (tallies.get(tone) || 0) + 1); }
      area.tally.replaceChildren(...B.TONE_ORDER.filter((tone) => tallies.get(tone)).map((tone) =>
        h('span', { title: `${B.TONES[tone].word}: ${tallies.get(tone)}` }, flagEl(B.TONES[tone].flag), h('span', { class: 'sr-only', text: B.TONES[tone].word + ' ' }), tallies.get(tone))));
      let visible = 0;
      tasks.forEach((t, i) => {
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
        placeAt(area.grid, el, i);
      });
      area.root.classList.toggle('hidden-by-filter', visible === 0);
      placeAt(ui.areas, area.root, areaKeys.indexOf(key));
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
      ui.areas.append(h('div', { class: 'empty-card empty-deck' }, h('h3', { text: 'No workers on deck' }), h('p', { text: 'Ask the first mate for work in the chat, or start a New job from the Board.' })));
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
            { duration: 450, easing: 'cubic-bezier(.2,.7,.2,1)' });
        }
      }
    }
    document.body.classList.toggle('has-tmux', !!snap.tmux.available);
  }

  // ---------- cabins: second mates as portholes ----------
  function renderCabins() {
    const metas = snap.tasks.filter((t) => t.kind === 'secondmate');
    const reg = snap.secondmates.registry || [];
    const ids = new Set(metas.map((t) => t.id));
    const vacant = reg.filter((r) => !ids.has(r.id));
    ui.cabins.hidden = !metas.length && !vacant.length;
    if (ui.cabins.hidden) return;
    if (unchanged('cabins', metas.map((t) => [t.id, t.title, taskStatus(t), matchesTask(t)]), vacant)) return;
    const kids = [];
    for (const t of metas.sort(sortTasks)) {
      const st = taskStatus(t);
      const c = h('button', { class: `porthole tone-${st.tone}`, type: 'button', title: L.summary(t), onclick: () => openDrawer({ type: 'task', id: t.id }) },
        h('span', { class: 'ring' }, icon('i-helm')), h('span', { class: 'strong', text: t.title || t.id }), pillEl(st, 'sm'));
      c.classList.toggle('hidden-by-filter', !matchesTask(t));
      kids.push(c);
    }
    for (const r of vacant) {
      kids.push(h('button', { class: 'porthole vacant', type: 'button', title: r.description || r.scope || '', onclick: () => openDrawer({ type: 'secondmate', id: r.id }) },
        h('span', { class: 'ring' }), h('span', { text: `${r.id}, not running` })));
    }
    ui.cabinRow.replaceChildren(...kids);
  }

  // ---------- hold: the queue ----------
  function renderHold() {
    const queued = snap.backlog.queued || [];
    const shown = queued.filter((q) => !q.checked && matchesCrate(q));
    const calls = queued.filter((q) => q.captainCall && !q.checked).length;
    ui.holdSub.textContent = `${shown.length} waiting${calls ? `, ${calls} need${calls === 1 ? 's' : ''} you` : ''}`;
    ui.hold.classList.toggle('hidden-by-filter', !!query && !shown.length);
    if (unchanged('hold', queued, shown.map((q) => queued.indexOf(q)), snap.backlog.present)) return;
    const kids = shown.slice(0, MAX_CRATES).map((q) => {
      const index = queued.indexOf(q);
      return h('button', {
        class: 'crate' + (q.captainCall ? ' call' : ''), type: 'button', title: q.captainCall ? 'Needs your answer' : 'Up next',
        onclick: () => openDrawer({ type: 'backlog', id: itemKey(q), section: 'queued', index }),
      }, q.captainCall ? flagEl('k') : null, h('span', { text: q.title || q.id }));
    });
    if (shown.length > MAX_CRATES) kids.push(h('span', { class: 'crate more', text: `${shown.length - MAX_CRATES} more` }));
    if (!shown.length) kids.push(h('p', { class: 'hint', text: snap.backlog.present ? 'The queue is empty.' : 'No queue yet.' }));
    ui.crates.replaceChildren(...kids);
  }

  // ---------- bridge: captain, first mate, monitoring ----------
  function renderBridge() {
    const name = (snap.captain && snap.captain.name) || 'Captain';
    ui.captain.classList.toggle('away', snap.afk);
    ui.captainName.textContent = name;
    ui.captainState.textContent = snap.afk ? 'Ashore' : 'On the bridge';
    const w = snap.watcher;
    ui.lamp.className = 'lamp ' + (w.lastBeat ? (w.healthy ? 'on' : 'late') : 'off');
    ui.lampLabel.textContent = w.lastBeat ? `${w.healthy ? 'Checked' : 'Late, checked'} ${agoLong(w.lastBeat)}` : 'Not running';
  }

  // ---------- orders: posting, confirm dialog, lifecycle ----------
  const IRREVERSIBLE = new Set(['merge', 'cleanup', 'cleanup-done']);

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
      return { ok: false, error: 'cannot reach Ship Deck (your text is kept)' };
    }
  }

  // In-page confirm: resolves true only on an explicit "Send".
  let confirmResolve = null;
  function confirmDialog({ title, body, irreversible, yes = 'Send' }) {
    if (confirmResolve) confirmResolve(false);
    ui.confirmTitle.textContent = title;
    ui.confirmBody.replaceChildren(...(body === undefined || body === null ? [] : [typeof body === 'string' ? h('p', { class: 'confirm-text', text: body }) : body]));
    ui.confirmWarn.hidden = !irreversible;
    ui.confirmWarn.textContent = irreversible
      ? 'This cannot be undone once carried out. Ship Deck only passes the message on: the first mate will still confirm with you before acting.'
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
    const bits = [L.kindLabel(req.kind)];
    if (req.target) bits.push(titleOf(req.target));
    if (req.item) bits.push(req.item);
    if (req.project) bits.push(`${req.taskKind || ''} in ${req.project}`.trim());
    return bits.join(' · ');
  }
  // Sends a message (an order) after the in-page confirm. Returns true when sent.
  async function queueOrder(req, confirm) {
    if (confirm !== false) {
      const c = confirm || {};
      const ok = await confirmDialog({
        title: c.title || `Send “${describe(req)}” to the first mate?`,
        body: c.body !== undefined ? c.body : req.text || null,
        irreversible: IRREVERSIBLE.has(req.kind),
      });
      if (!ok) return false;
    }
    const r = await post('/api/orders', req);
    if (r.ok) {
      toast(`Sent to the first mate: ${describe(req)}`, 'ok');
      poll();
      return true;
    }
    toast(`Message not sent: ${r.error}`, 'err');
    return false;
  }
  function toast(text, kind) {
    const el = h('div', { class: 'toast ' + (kind || ''), role: kind === 'err' ? 'alert' : 'status', text });
    ui.toasts.append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, kind === 'err' ? 7000 : 3500);
  }

  function timeOf(ts) { const t = ts ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : null; }
  function clock(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
  function titleOfItem(id) {
    for (const k of ['captain', 'inFlight', 'queued', 'done', 'other']) { const b = ((snap && snap.backlog[k]) || []).find((x) => x.id === id); if (b && b.title) return b.title; }
    return id;
  }
  function payloadText(o) {
    if (o.kind === 'cleanup-done' && o.targets) return `${o.targets.length} worker${o.targets.length === 1 ? '' : 's'}: ${o.targets.map(titleOf).join(', ')}`;
    if (o.kind === 'new-task') return `${sentence(o.taskKind || 'ship')} job in ${o.project}${o.harness ? `, ${B.toolText({ harness: o.harness, model: o.model, effort: o.effort })}` : ''}`;
    if (o.kind === 'config') return `${sentence(o.field)} to ${o.value}, ${o.applied ? 'applied live' : 'on relaunch'}`;
    if (o.item) return titleOfItem(o.item) + (o.option ? `, option ${o.option}` : '');
    if (o.option) return `Option ${o.option}`;
    return '';
  }
  // Sent -> Seen -> Done (or Declined): one row of receipts, each step with its time, then the note.
  function lifecycle(o) {
    const at = (st) => (o.history || []).find((a) => a.status === st);
    const seen = at('acknowledged') || (o.status !== 'pending' ? {} : null);
    const end = at(o.status === 'declined' ? 'declined' : 'done');
    const step = (label, on, ts, cls) => h('li', { class: 'lc-step' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), title: ts ? new Date(timeOf(ts)).toLocaleString() : null },
      label, ts ? ' ' + clock(timeOf(ts)) : '');
    const last = (o.history || []).filter((a) => a.note).pop();
    return h('div', { class: 'steps' },
      h('ol', { class: 'lifecycle', 'aria-label': `Message ${L.messageStatus(o.status)}` },
        step('Sent', true, o.ts),
        step('Seen', !!seen, seen && seen.ts),
        o.status === 'declined' ? step('Declined', true, end && end.ts, 'no') : step('Done', o.status === 'done', end && end.ts)),
      last ? h('p', { class: 'lc-note', text: `“${last.note}”` }) : null);
  }

  // A message in a drawer list: what was asked, when, and its receipts.
  function orderRow(o) {
    const extra = payloadText(o);
    const note = [o.text, extra].filter(Boolean).join(' · ');
    return h('li', { class: 'order-row' },
      h('div', { class: 'o-line' }, o.kind === 'decision' || o.kind === 'backlog-answer' ? flagEl('k') : icon(KIND_ICON[o.kind] || 'i-chat', 'ico muted'),
        h('span', { class: 'o-kind', text: L.kindLabel(o.kind) }), h('span', { class: 'r-age', text: whenText(timeOf(o.ts)) })),
      note ? h('p', { class: 'o-note', text: note }) : null,
      lifecycle(o));
  }

  // ---------- the Board (default view) ----------
  // Needs you / Working / Waiting (+ quiet and the queue) / Done. Cards are keyed and rebuilt
  // only when their content changes, so typing in a card's reply box survives polling.
  function emptyRow(text) { return h('li', null, h('div', { class: 'empty', text })); }
  function itemKey(b) { return b.id || b.title; }
  let boardProject = store.get('boardProject');
  const cards = new Map(); // key -> { sig, el, age }
  const colEls = new Map(); // column key -> { root, head, body }

  function answerText(opt, extra) {
    return opt ? `(${opt.letter}) ${opt.text}${extra ? '\n\n' + extra : ''}` : extra;
  }
  // A one-line answer box kept as a draft; send(text) resolves true when sent.
  function replyRow(draftKey, placeholder, label, send) {
    const input = persist(h('input', { class: 'input', type: 'text', maxlength: '2000', placeholder, 'aria-label': placeholder, autocomplete: 'off' }), draftKey);
    const form = h('form', { class: 'reply-row' }, input, h('button', { class: 'btn sm', type: 'submit', text: label }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      if (await send(text)) clearDraft(input);
    });
    return form;
  }
  function optionButtons(options, onPick) {
    return h('div', { class: 'opts', role: 'group', 'aria-label': 'Answer with an option' }, ...options.map((o) =>
      h('button', { class: 'opt' + (o.recommended ? ' rec' : ''), type: 'button', 'data-letter': o.letter, title: `Answer with option ${o.letter}`, onclick: () => onPick(o) },
        h('b', { text: o.letter }), h('span', null, o.text, o.recommended ? h('span', { class: 'rec-tag', text: 'Recommended' }) : null))));
  }
  function answerTask(t, opt, text) {
    const name = t.title || t.id;
    const body = answerText(opt, text);
    return queueOrder({ kind: 'decision', target: t.id, option: opt ? opt.letter : null, text: body }, {
      title: opt ? `Answer “${name}” with option ${opt.letter}?` : `Send this answer to “${name}”?`, body,
    });
  }
  function answerCall(b, opt, text) {
    const name = b.title || b.id;
    const body = answerText(opt, text);
    return queueOrder({ kind: 'backlog-answer', item: b.id, option: opt ? opt.letter : null, text: body }, {
      title: opt ? `Answer “${name}” with option ${opt.letter}?` : `Send this answer on “${name}”?`, body,
    });
  }
  function cleanupTask(t) {
    return queueOrder({ kind: 'cleanup', target: t.id }, { title: `Ask the first mate to clean up “${t.title || t.id}”?`, body: 'Closes its terminal and workspace once its work is safe.' });
  }
  function openReport(t) { openDrawer({ type: 'task', id: t.id }); openDataFile(t.id, 'report.md'); }

  // A card: status pill and age, title (opens the drawer), id and project, summary, then actions.
  function cardShell(key, tone, hoist, pill, title, onOpen, meta, summary, ...rest) {
    const age = h('span', { class: 'age' });
    const el = h('article', { class: `bcard tone-${tone}` + (hoist ? ' hoist' : ''), 'data-key': key },
      h('div', { class: 'card-top' }, pill, age),
      h('h3', { class: 'card-title' }, h('button', { class: 'card-link', type: 'button', onclick: onOpen }, title)),
      h('div', { class: 'card-meta' }, ...meta),
      summary ? h('p', { class: 'card-summary', text: summary }) : null,
      ...rest);
    return { el, age };
  }
  function cached(key, sig, build) {
    const c = cards.get(key);
    if (c && c.sig === sig) return c;
    const made = { sig, ...build() };
    cards.set(key, made);
    return made;
  }
  function taskCard(t, col) {
    const st = taskStatus(t);
    const summary = B.cardSummary(t);
    const sig = JSON.stringify([col, st, t.title, t.project, summary, t.options, t.pr, t.hasReport, t.state, B.toolText(t)]);
    const c = cached('t:' + t.id, sig, () => {
      const name = t.title || t.id;
      let ask = null;
      if (t.state === 'needs-decision' || t.state === 'blocked') {
        ask = !t.stale && t.options.length
          ? optionButtons(t.options, (o) => answerTask(t, o, ''))
          : !t.stale ? replyRow('card.' + t.id, t.state === 'blocked' ? 'Reply to unblock…' : 'Your answer…', 'Send', (text) => answerTask(t, null, text)) : null;
      }
      const foot = [
        safeUrl(t.pr) ? h('a', { class: 'chip', href: safeUrl(t.pr), target: '_blank', rel: 'noopener noreferrer', title: 'Open the pull request' }, icon('i-pr'), prNumber(t.pr)) : null,
        t.state === 'done' && t.hasReport ? h('button', { class: 'chip', type: 'button', onclick: () => openReport(t) }, icon('i-file'), 'Read report') : null,
        t.state === 'failed' ? h('button', { class: 'btn sm', type: 'button', text: 'Ask for status', onclick: () => queueOrder({ kind: 'status', target: t.id }) }) : null,
        t.state === 'done' ? h('button', { class: 'btn sm ghost', type: 'button', text: 'Clean up', onclick: () => cleanupTask(t) }) : null,
        h('span', { class: 'tool', text: B.toolText(t) }),
      ].filter(Boolean);
      return cardShell('t:' + t.id, st.tone, col === 'needs', pillEl(st), name, () => openDrawer({ type: 'task', id: t.id }),
        [name !== t.id ? h('code', { text: t.id }) : null, h('span', { text: t.project })], summary,
        ask, h('div', { class: 'card-foot' }, ...foot));
    });
    c.el.classList.toggle('selected', !!selected && selected.type === 'task' && selected.id === t.id);
    c.age.textContent = t.lastActivity ? agoLong(t.lastActivity) : '';
    return c.el;
  }
  function callCard(b) {
    const key = 'c:' + itemKey(b);
    const hold = b.tags && b.tags.hold ? B.cardSummary({ options: b.options, lastStatus: [{ note: b.tags.hold }] }, 200) : '';
    const sig = JSON.stringify([b.id, b.title, hold, b.options, b.section, b.index, b.tags && b.tags.repo]);
    const c = cached(key, sig, () => {
      const open = (focus) => openDrawer({ type: 'backlog', id: itemKey(b), section: b.section, index: b.index, focus });
      const ask = !b.id ? h('p', { class: 'hint', text: 'No id, so answer it in the chat.' })
        : b.options && b.options.length ? optionButtons(b.options, (o) => answerCall(b, o, ''))
          : replyRow('call.' + b.id, 'Your answer…', 'Answer', (text) => answerCall(b, null, text));
      return cardShell(key, 'needs', true, pillEl(B.callStatus()), b.title || b.id, () => open(false),
        [b.id ? h('code', { text: b.id }) : null, h('span', { text: (b.tags && b.tags.repo) || 'Queue' })], hold, ask);
    });
    c.age.textContent = b.tags && b.tags.since ? `since ${shortDate(b.tags.since)}` : '';
    return c.el;
  }
  function queueRow({ b, index }) {
    const key = 'q:' + itemKey(b);
    const after = b.tags && b.tags.after;
    const sub = after ? `after ${titleOf(after)}` : (b.tags && b.tags.repo) || (b.id ? '' : 'No id: ask in the chat to start it');
    const c = cached(key, JSON.stringify([b.id, b.title, sub, index]), () => {
      const el = h('div', { class: 'row-card', 'data-key': key },
        h('div', { class: 't' },
          h('button', { class: 'card-link', type: 'button', text: b.title || b.id, onclick: () => openDrawer({ type: 'backlog', id: itemKey(b), section: 'queued', index }) }),
          sub ? h('span', { text: sub }) : null),
        b.id ? h('button', { class: 'btn sm', type: 'button', text: 'Start', onclick: () => startBacklog(b) }) : null);
      return { el, age: null };
    });
    return c.el;
  }
  function emptyCard(title, text) { return h('div', { class: 'empty-card' }, h('h3', { text: title }), text ? h('p', { text }) : null); }
  function subHead(text, n) { return h('div', { class: 'sub-head' }, text, h('span', { class: 'count', text: n })); }
  // "2026-01-03" -> "3 Jan" (year kept when it differs).
  function shortDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return s;
    const d = new Date(+m[1], m[2] - 1, +m[3]);
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function setKids(el, kids) {
    const now = [...el.children];
    if (now.length === kids.length && now.every((k, i) => k === kids[i])) return;
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    el.replaceChildren(...kids);
    if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  function column(key) {
    let c = colEls.get(key);
    if (!c) {
      const head = h('div', { class: 'col-head' });
      const body = h('div', { class: 'col-body' });
      c = { root: h('section', { class: 'col', 'data-col': key, 'aria-label': B.COLUMNS.find((x) => x.key === key).title }, head, body), head, body };
      colEls.set(key, c);
    }
    return c;
  }

  function renderBoard() {
    const g = B.groupBoard(snap, { project: boardProject, match: matchesTask, matchItem: matchesCrate });
    if (boardProject && !g.projects.some((p) => p.toLowerCase() === boardProject.toLowerCase())) { boardProject = null; store.set('boardProject', null); return renderBoard(); }
    ui.boardTitle.textContent = boardProject || 'All work';
    if (!unchanged('board-filters', g.projects, boardProject)) {
      const chipBtn = (name, label) => h('button', { class: 'filter', type: 'button', 'aria-pressed': String((boardProject || null) === name), text: label,
        onclick: () => { boardProject = name; store.set('boardProject', name); renderAll(); } });
      ui.projectFilters.replaceChildren(...(g.projects.length > 1 ? [chipBtn(null, 'All projects'), ...g.projects.map((p) => chipBtn(p, p))] : []));
    }
    const filtered = !!(query || boardProject);
    const nothing = !snap.tasks.length && !(snap.backlog.queued || []).length;
    const bodies = {
      needs: g.needs.length ? g.needs.map((x) => (x.type === 'task' ? taskCard(x.t, 'needs') : callCard(x.b)))
        : [emptyCard('Nothing needs you', nothing ? 'No workers yet. Ask the first mate for work in the chat, or start a New job.'
          : filtered ? 'Nothing here matches the filter.' : 'Workers are moving. A flag goes up here, with an alert if you turn them on, when one needs your call.')],
      working: g.working.length ? g.working.map((t) => taskCard(t, 'working')) : [h('p', { class: 'col-note', text: 'No one is working right now.' })],
      waiting: [
        ...g.waiting.map((t) => taskCard(t, 'waiting')),
        ...(g.quiet.length ? [subHead('Quiet for a while', g.quiet.length), ...g.quiet.map((t) => taskCard(t, 'quiet'))] : []),
        ...(g.queue.length ? [subHead('Up next in the queue', g.queue.length), ...g.queue.map(queueRow)] : []),
      ],
      done: [...g.done.map((t) => taskCard(t, 'done')), h('p', { class: 'col-note', text: g.done.length ? 'Finished work stays here until you clean it up.' : 'Nothing finished yet.' })],
    };
    if (!bodies.waiting.length) bodies.waiting.push(h('p', { class: 'col-note', text: 'Nothing is waiting.' }));
    const counts = { needs: g.counts.needs, working: g.counts.working, waiting: g.counts.waiting, done: g.counts.done };
    const roots = B.COLUMNS.map((def) => {
      const c = column(def.key);
      if (!unchanged('col-head-' + def.key, counts[def.key], def.key === 'done' && g.done.map((t) => t.id))) {
        c.head.replaceChildren(...[flagEl(def.flag), h('h2', { text: def.title }),
          h('span', { class: 'count' + (def.key === 'needs' && counts.needs ? ' needs' : ''), text: counts[def.key], title: `${counts[def.key]} in ${def.title}` }),
          h('span', { class: 'spacer' }),
          def.key === 'done' && g.done.length ? h('button', { class: 'btn sm ghost', type: 'button', text: g.done.length === 1 ? 'Clean up' : 'Clean up all', onclick: () => cleanupDone(g.done) }) : null].filter(Boolean));
      }
      setKids(c.body, bodies[def.key]);
      return c.root;
    });
    setKids(ui.cols, roots);
    // Forget cards that left the board.
    const live = new Set([...ui.cols.querySelectorAll('[data-key]')].map((el) => el.dataset.key));
    for (const k of cards.keys()) if (!live.has(k)) cards.delete(k);
    renderMates(g);
  }

  // Second mates: one chip each, vacant ones dashed.
  function renderMates(g) {
    ui.mates.hidden = !g.mates.length && !g.vacant.length;
    if (ui.mates.hidden || unchanged('mates', g.mates.map((t) => [t.id, t.title, taskStatus(t), lastNote(t)]), g.vacant)) return;
    ui.mates.replaceChildren(h('h3', { text: 'Second mates' }),
      ...g.mates.map((t) => h('button', { class: 'mate-chip', type: 'button', title: L.summary(t), onclick: () => openDrawer({ type: 'task', id: t.id }) },
        h('span', { class: 'fm-avatar' }, icon('i-helm')), h('span', { class: 'strong', text: t.title || t.id }), pillEl(taskStatus(t), 'sm'))),
      ...g.vacant.map((r) => h('button', { class: 'mate-chip vacant', type: 'button', onclick: () => openDrawer({ type: 'secondmate', id: r.id }) },
        h('span', { text: r.id }), h('span', { class: 'muted', text: 'not running' }))));
  }

  function needsCaptain() { return snap.tasks.filter((t) => ATTENTION.has(t.state) && !t.stale).sort(sortTasks); }

  function cleanupDone(done) {
    const ids = done.map((t) => t.id).sort();
    if (!ids.length) return;
    const one = ids.length === 1;
    queueOrder({ kind: 'cleanup-done', targets: ids }, {
      title: one ? `Clean up the finished worker “${titleOf(ids[0])}”?` : `Clean up all ${ids.length} finished workers?`,
      body: h('div', null, h('p', { class: 'confirm-text', text: one ? 'Closes its terminal and workspace once its work is safe.' : 'One message listing every finished worker:' }),
        one ? null : h('ul', { class: 'confirm-list' }, ...ids.map((id) => h('li', { text: titleOf(id) })))),
    });
  }

  // ---------- new job (a sheet over the board) ----------
  function openJobSheet() {
    if (!snap || snap.firstRun) return;
    ui.jobSheet.hidden = false;
    ui.jobScrim.hidden = false;
    renderJobProjects();
    renderJobConfig();
    (ui.jobProject.value ? ui.jobText : ui.jobProject).focus();
  }
  function closeJobSheet() {
    ui.jobSheet.hidden = true;
    ui.jobScrim.hidden = true;
    ui.newJobBtn.focus({ preventScroll: true });
  }
  ui.newJobBtn.addEventListener('click', openJobSheet);
  ui.jobClose.addEventListener('click', closeJobSheet);
  ui.jobCancel.addEventListener('click', closeJobSheet);
  ui.jobScrim.addEventListener('click', closeJobSheet);

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
      title: `Send a new ${taskKind} job in ${project}?`, body: `${text}\n\n(${setup})`,
    });
    if (ok) { clearDraft(ui.jobText); closeJobSheet(); }
  });

  async function startBacklog(b, note) {
    return queueOrder({ kind: 'backlog-start', item: b.id, text: note || `Start ${b.id}: ${b.title}` }, {
      title: `Start “${b.title || b.id}”?`, body: `From the queue (${b.id}).`,
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
      const label = btn.querySelector('.lbl') || btn;
      const prev = label.textContent;
      label.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { label.textContent = prev; }, 1300);
    }
  }

  // "Open in terminal": the folder (home shortened to ~) and the resume command; Copy copies
  // the full command with the real path.
  function resumeBlock(sess) {
    const wrap = h('div', { class: 'resume' });
    if (!sess || !sess.resume) {
      wrap.append(h('p', { class: 'empty', text: sess && sess.note ? sentence(sess.note) : 'No session recorded.' }));
      return wrap;
    }
    const btn = h('button', { class: 'btn sm', type: 'button', title: 'Copy the full command (cd into the folder, then resume)' }, icon('i-copy'), h('span', { class: 'lbl', text: 'Copy' }));
    btn.addEventListener('click', () => copyText(sess.resume, btn));
    wrap.append(h('div', { class: 'resume-row' }, h('code', { class: 'resume-cmd', text: `claude --resume ${sess.sessionId}` }), btn),
      h('p', { class: 'hint resume-meta', text: [`In ${sess.cwdLabel || 'its workspace'}`, sess.lastSeen ? `seen ${agoLong(sess.lastSeen)}` : null].filter(Boolean).join(', ') }));
    return wrap;
  }
  const sentence = (s) => { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : s; };

  // firstmate kind and mode in words.
  const KIND_WORDS = { ship: 'Ship: makes the change and opens a pull request', scout: 'Scout: diagnoses and writes a report', secondmate: 'Second mate: runs its own lane' };
  const MODE_WORDS = { 'no-mistakes': 'Full review pipeline before push', 'direct-PR': 'Opens a pull request directly', 'local-only': 'Local only, no pull request' };

  // The worker drawer keeps its interactive parts (terminal, message box, tabs, file viewer)
  // across polls; the header and each tab's facts are rebuilt only when they change.
  let td = null;
  const DRAWER_TABS = [['terminal', 'Terminal'], ['updates', 'Updates'], ['details', 'Details'], ['settings', 'Model and effort']];

  function renderTaskDrawer() {
    const t = snap.tasks.find((x) => x.id === selected.id);
    if (!t) {
      stopPeek();
      td = null;
      ui.drawerKicker.replaceChildren(h('span', { class: 'pill plain', text: 'Cleaned up' }));
      ui.drawerTitle.textContent = titleOf(selected.id);
      ui.drawerSub.replaceChildren();
      ui.drawerBody.replaceChildren(h('p', { text: 'This worker has been cleaned up. Its session stays listed under the first mate’s past sessions.' }));
      return;
    }
    if (!td || td.id !== t.id || !td.root.isConnected) buildTaskDrawer(t);
    td.task = t;
    ui.drawerKicker.replaceChildren(pillEl(taskStatus(t)), h('span', { text: t.lastActivity ? `Last update ${agoLong(t.lastActivity)}` : 'No update yet' }));
    ui.drawerTitle.textContent = t.title || t.id;
    if (!unchanged('drawer-head', t.id, t.title, t.project, t.pr, B.toolText(t), t.window, t.alive)) renderTaskHead(t);
    if (!unchanged('drawer-resume', t.id, t.session)) td.termOpen.replaceChildren(h('p', { class: 'hint', text: 'Copy into a terminal to pick up this worker’s Claude Code session.' }), resumeBlock(t.session));
    if (!unchanged('drawer-decision', t.id, t.state, t.stale, lastNote(t), t.options)) renderDecision(t);
    if (!unchanged('drawer-updates', t.id, t.lastStatus)) renderUpdates(t);
    if (!unchanged('drawer-details', t, snap.tmux.available)) td.details.replaceChildren(...taskDetails(t));
    if (!unchanged('drawer-config', t.id, t.config, t.window, snap.configOptions)) renderConfig(t);
    renderTaskOrders(t);
    td.tabBtns.terminal.hidden = !t.window;
    if (!t.window && td.tab === 'terminal') showDrawerTab('updates');
  }

  function renderTaskHead(t) {
    const d = td;
    d.meta.replaceChildren(...[
      t.title && t.title !== t.id ? h('code', { text: t.id }) : null,
      h('span', { text: t.project }),
      safeUrl(t.pr) ? h('a', { class: 'chip', href: safeUrl(t.pr), target: '_blank', rel: 'noopener noreferrer', title: 'Open the pull request (O)' }, icon('i-pr'), prNumber(t.pr), icon('i-ext')) : null,
      h('span', { class: 'chip', text: B.toolText(t) }),
      t.window && t.alive === false ? h('span', { class: 'chip', text: 'Terminal closed' }) : null,
    ].filter(Boolean));
    d.mergeBtn.hidden = !t.pr;
    d.prLink = safeUrl(t.pr);
  }

  // Latest update first, every one with its flag and one timestamp format.
  function renderUpdates(t) {
    const recent = t.lastStatus.slice().reverse();
    td.tabBtns.updates.querySelector('.count').textContent = recent.length;
    td.updates.replaceChildren(recent.length
      ? h('ol', { class: 'timeline' }, ...recent.map((e) => {
        const ms = e.ts ? localTime(e.ts) : e.approxTs;
        const st = B.statusOf({ state: e.state });
        const note = h('div', { class: 't-note', text: sentence(e.note), title: 'Click to expand' });
        note.addEventListener('click', () => note.classList.toggle('expanded'));
        return h('li', null, flagEl(st.flag, 'lg'), h('div', null, note, h('div', { class: 't-when', text: `${st.label}, ${ms ? whenText(ms) : 'time not recorded'}` })));
      }))
      : h('p', { class: 'empty', text: 'No update yet. The worker writes one when it starts, gets stuck or finishes.' }));
    // The Terminal tab's one-line "latest" strip; hidden while the decision box shows the same note.
    const last = recent[0];
    td.latest.hidden = !last || !td.decision.hidden;
    if (last) {
      const st = B.statusOf({ state: last.state });
      const ms = last.ts ? localTime(last.ts) : last.approxTs;
      td.latest.replaceChildren(flagEl(st.flag, 'lg'), h('span', { class: 'latest-note', text: sentence(last.note) }), h('span', { class: 'when', text: ms ? whenText(ms) : '' }));
    }
  }

  function taskDetails(t) {
    const kids = [];
    if (t.brief) kids.push(h('p', { class: 'brief', text: t.brief }));
    const links = h('div', { class: 'links' });
    for (const name of t.files || []) links.append(h('button', { class: 'chip', type: 'button', title: `${name} (read-only)`, onclick: () => openDataFile(t.id, name) }, icon('i-file'), name));
    if (links.childNodes.length) kids.push(links);
    const dl = h('dl', { class: 'facts' });
    fact(dl, 'Project', t.project);
    fact(dl, 'Kind', KIND_WORDS[t.kind] || sentence(t.kind));
    fact(dl, 'Checks', t.mode ? MODE_WORDS[t.mode] || t.mode : null);
    fact(dl, 'Tool', B.toolText(t));
    fact(dl, 'Terminal', t.window ? (t.alive === true ? 'Open' : t.alive === false ? 'Closed' : snap.tmux.available ? 'Not found' : 'Not checked (no tmux)') : 'None');
    if (t.worktree) {
      const b = h('button', { class: 'btn sm', type: 'button', title: 'Copy the workspace folder path' }, icon('i-copy'), h('span', { class: 'lbl', text: 'Copy folder path' }));
      b.addEventListener('click', () => copyText(t.worktree, b));
      fact(dl, 'Workspace', b);
    }
    fact(dl, 'Pull request head', t.prHead ? t.prHead.slice(0, 12) : null, true);
    fact(dl, 'Last activity', t.lastActivity ? `${whenText(t.lastActivity)} (${agoLong(t.lastActivity)})` : null);
    if (t.stale) fact(dl, 'Quiet', staleText(t));
    fact(dl, 'Turn ended', t.turnEnded ? whenText(t.turnEnded) : 'Not yet');
    kids.push(dl, h('h3', { text: 'Messages about this worker' }), td.ordersList);
    return kids;
  }

  // Lettered option buttons plus a free-text answer; one shared builder for worker
  // decisions and the queue's questions.
  function answerPanel({ options, draftKey, placeholder, send }) {
    const text = persist(h('textarea', { rows: '3', maxlength: '2000', placeholder, 'aria-label': placeholder }), draftKey);
    const opts = (options || []).length ? optionButtons(options, async (o) => { if (await send(o, text.value.trim())) clearDraft(text); }) : null;
    const sendBtn = h('button', { class: 'btn primary', type: 'button', text: 'Send answer', onclick: async () => {
      if (!text.value.trim()) { text.focus(); return; }
      if (await send(null, text.value.trim())) clearDraft(text);
    } });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBtn.click(); } });
    return h('div', { class: 'answer' },
      opts,
      opts ? h('p', { class: 'hint', text: 'Pick an option to answer with it; anything in the box below goes along with it.' }) : null,
      text, h('div', { class: 'btn-row end' }, sendBtn));
  }

  function renderDecision(t) {
    const show = (t.state === 'needs-decision' || t.state === 'blocked') && !t.stale;
    td.decision.hidden = !show;
    if (!show) { td.decision.replaceChildren(); td.latest.hidden = !t.lastStatus.length; return; }
    const st = taskStatus(t);
    td.decision.className = `decision-sec tone-${st.tone}`;
    td.decision.replaceChildren(
      h('h3', null, flagEl(st.flag), t.state === 'blocked' ? 'Blocked: help it along' : 'Needs your call'),
      h('div', { class: 'decision-note', text: B.cardSummary(t, 2000) || 'No note.' }),
      answerPanel({
        options: t.options,
        draftKey: 'decision.' + t.id,
        placeholder: t.options.length ? 'Optional note, or your own answer…' : 'Your answer…',
        send: (opt, extra) => answerTask(t, opt, extra),
      }));
    td.latest.hidden = true;
  }

  // Current harness/model/effort with allow-listed pickers; claude workers apply live.
  function renderConfig(t) {
    const c = t.config || { harness: t.harness || 'claude', model: t.model, effort: t.effort, pending: {} };
    const spec = (snap.configOptions || {})[c.harness] || {};
    const live = !!spec.live && !!t.window;
    const show = (field) => [c[field] || 'default', c.pending[field] ? `, ${c.pending[field]} on relaunch` : ''].join('');
    const rows = [];
    for (const field of ['model', 'effort']) {
      const list = spec[field];
      const label = field === 'model' ? 'Model' : 'Effort';
      if (!list) {
        rows.push(h('div', { class: 'cfg-row' }, h('span', { class: 'cfg-label', text: label }), h('span', { class: 'cfg-val mono', text: show(field) }), h('span', { class: 'hint cfg-fixed', text: 'Shown only; this tool has no choices here' })));
        continue;
      }
      const choice = L.configChoices(list, c[field], c.pending[field]);
      const sel = h('select', { 'aria-label': `${label} for ${t.title || t.id}` }, ...choice.options.map(([v, text]) => h('option', { value: v, text })));
      sel.value = choice.selected;
      const btn = h('button', { class: 'btn', type: 'button', disabled: true, text: live ? 'Apply live' : 'Send change', onclick: () => sel.value && applyConfig(t, field, sel.value, live) });
      sel.addEventListener('change', () => { btn.disabled = !sel.value; });
      rows.push(h('div', { class: 'cfg-row' }, h('span', { class: 'cfg-label', text: label }), h('span', { class: 'cfg-val mono', text: show(field) }), h('span', { class: 'cfg-ctl' }, sel, btn)));
    }
    td.config.replaceChildren(
      h('p', { class: 'hint', text: `Tool: ${B.toolText({ harness: c.harness })}. ` + (live
        ? 'Changes are typed into its terminal as /model or /effort; Claude Code applies them from its next turn.'
        : spec.live ? 'No terminal is open for it, so the first mate applies changes when it next restarts the worker.'
          : 'This tool cannot change live; the first mate applies changes when it next restarts the worker.') }),
      ...rows);
  }
  async function applyConfig(t, field, value, live) {
    const ok = await confirmDialog({
      title: `Set the ${field} of “${t.title || t.id}” to ${value}?`,
      body: live
        ? `Types “/${field} ${value}” into its terminal now. It applies from the worker's next turn, and the first mate is told about the change.`
        : 'Tells the first mate, who applies it when it next restarts this worker.',
      yes: live ? 'Apply now' : 'Send change',
    });
    if (!ok) return;
    const r = await post('/api/config', { id: t.id, field, value });
    if (r.ok) { toast(r.applied ? `Sent ${r.command} to ${t.title || t.id}` : `Sent: ${field} ${value} on restart`, 'ok'); poll(); }
    else toast(`Settings change failed: ${r.error}`, 'err');
  }

  function showDrawerTab(name) {
    if (!td) return;
    if (name === 'terminal' && td.tabBtns.terminal.hidden) name = 'updates';
    td.tab = name;
    store.set('drawerTab', name);
    for (const [k] of DRAWER_TABS) {
      const on = k === name;
      td.tabBtns[k].setAttribute('aria-selected', String(on));
      td.tabBtns[k].tabIndex = on ? 0 : -1;
      td.panels[k].hidden = !on;
    }
    if (name === 'terminal') refreshPeek();
  }

  function buildTaskDrawer(t) {
    stopPeek();
    const id = t.id;
    const d = { id };
    const name = () => (td && td.task && td.task.title) || id;

    // Header: meta chips, the asks, the "Open in terminal" panel and the tabs.
    d.meta = h('div', { class: 'd-meta' });
    d.mergeBtn = h('button', { class: 'btn sm', type: 'button', text: 'Merge PR…', onclick: () => queueOrder({ kind: 'merge', target: id }, { title: `Ask the first mate to merge the pull request of “${name()}”?`, body: (td && td.task && td.task.pr) || null }) });
    d.termOpen = h('div', { class: 'term-open', hidden: true });
    d.termBtn = h('button', { class: 'btn sm', type: 'button', 'aria-expanded': 'false', title: 'Show the command that resumes this worker’s session in your terminal', onclick: () => {
      d.termOpen.hidden = !d.termOpen.hidden;
      d.termBtn.setAttribute('aria-expanded', String(!d.termOpen.hidden));
      if (!d.termOpen.hidden) { const b = d.termOpen.querySelector('.btn'); if (b) b.focus(); }
    } }, icon('i-term'), 'Open in terminal');
    const actions = h('div', { class: 'd-actions' },
      h('button', { class: 'btn sm', type: 'button', text: 'Ask for status', title: 'Asks the first mate for a status update', onclick: () => queueOrder({ kind: 'status', target: id }) }),
      d.mergeBtn, d.termBtn,
      h('button', { class: 'btn sm danger', type: 'button', text: 'Clean up…', onclick: () => queueOrder({ kind: 'cleanup', target: id }, { title: `Ask the first mate to clean up “${name()}”?`, body: 'Closes its terminal and workspace once its work is safe.' }) }));
    d.tabBtns = {};
    d.panels = {};
    const tabs = h('div', { class: 'tabs d-tabs', role: 'tablist', 'aria-label': 'Worker' });
    DRAWER_TABS.forEach(([k, label], i) => {
      const b = h('button', { class: 'tab', role: 'tab', type: 'button', id: `dtab-${k}`, 'aria-controls': `dpanel-${k}`, title: `${label} (${i + 1})`, onclick: () => showDrawerTab(k) },
        label, k === 'updates' ? h('span', { class: 'count', text: '0' }) : null);
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const shown = DRAWER_TABS.map(([x]) => x).filter((x) => !d.tabBtns[x].hidden);
        const next = shown[(shown.indexOf(k) + (e.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length];
        showDrawerTab(next);
        d.tabBtns[next].focus();
      });
      d.tabBtns[k] = b;
      tabs.append(b);
    });
    ui.drawerSub.replaceChildren(d.meta, actions, d.termOpen, tabs);

    // File viewer: replaces the drawer body while open.
    d.fileTitle = h('span', { class: 'mono' });
    d.fileMeta = h('span', { class: 'file-meta' });
    d.fileText = h('pre', { class: 'file-text', tabindex: '0' });
    d.file = h('section', { class: 'file-view', hidden: true },
      h('div', { class: 'file-head' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => closeDataFile() }, icon('i-back'), 'Back'),
        d.fileTitle, d.fileMeta),
      d.fileText);

    d.decision = h('section', { class: 'decision-sec', hidden: true });
    d.latest = h('div', { class: 'latest', hidden: true });

    // Terminal: the live peek, then a one-line message straight to the worker (fm-send).
    d.peekText = h('pre', { class: 'peek', tabindex: '0', 'aria-label': `Terminal of ${name()}` });
    d.peekState = h('span', { class: 'peek-state' });
    d.peekDot = h('span', { class: 'live off' });
    d.pauseBtn = h('button', { class: 'tbtn', type: 'button', 'aria-pressed': 'false', title: 'Pause refreshing', onclick: () => {
      d.paused = !d.paused;
      d.pauseBtn.setAttribute('aria-pressed', String(d.paused));
      if (!d.paused) refreshPeek();
      setPeekState();
    } }, icon('i-pause'), h('span', { class: 'lbl', text: 'Pause' }));
    const toggle = (key, label, ico, title, apply) => {
      const btn = h('button', { class: 'tbtn', type: 'button', title, onclick: () => { d[key] = !d[key]; store.set('peek.' + key, d[key] ? '1' : '0'); apply(); } }, icon(ico), h('span', { class: 'lbl', text: label }));
      d[key] = store.get('peek.' + key) !== '0';
      return btn;
    };
    d.applyWrap = () => { d.peekText.classList.toggle('wrap', d.wrap); d.wrapBtn.setAttribute('aria-pressed', String(d.wrap)); if (d.follow) d.peekText.scrollTop = d.peekText.scrollHeight; };
    d.applyFollow = () => { d.followBtn.setAttribute('aria-pressed', String(d.follow)); if (d.follow) d.peekText.scrollTop = d.peekText.scrollHeight; };
    d.wrapBtn = toggle('wrap', 'Wrap', 'i-wrap', 'Wrap long lines (W)', d.applyWrap);
    d.followBtn = toggle('follow', 'Follow', 'i-follow', 'Stick to the newest line (F)', d.applyFollow);
    const copyBtn = h('button', { class: 'tbtn', type: 'button', title: 'Copy the visible output', 'aria-label': 'Copy the visible output', onclick: () => copyText(d.peekText.textContent, null).then(() => toast('Terminal output copied', 'ok')) }, icon('i-copy'));
    d.peekText.addEventListener('scroll', () => {
      const pre = d.peekText;
      if (d.follow && pre.scrollHeight - pre.scrollTop - pre.clientHeight > 24) { d.follow = false; d.applyFollow(); }
    });
    d.applyWrap(); d.applyFollow();
    const term = h('div', { class: 'term' },
      h('div', { class: 'term-bar' }, h('span', { class: 'peek-live' }, d.peekDot, d.peekState), d.wrapBtn, d.followBtn, d.pauseBtn, copyBtn),
      d.peekText,
      h('div', { class: 'term-foot' }, h('span', { text: 'Last lines of its terminal, colours kept' }), h('span', { class: 'spacer' }), h('span', { text: 'Read-only. To type into it, use Message the worker.' })));

    d.msg = persist(h('input', { class: 'input', type: 'text', maxlength: '2000', placeholder: 'One line, sent straight to this worker', 'aria-label': `Message to ${name()}`, autocomplete: 'off' }), 'msg.' + id);
    const sendBtn = h('button', { class: 'btn', type: 'submit', text: 'Send…' });
    const form = h('form', { class: 'msg-form' }, d.msg, sendBtn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = d.msg.value.replace(/\s+/g, ' ').trim();
      if (!text) { d.msg.focus(); return; }
      if (!await confirmDialog({ title: `Send to “${name()}” now?`, body: text, yes: 'Send now' })) return;
      sendBtn.disabled = true;
      const r = await post('/api/send', { id, message: text });
      sendBtn.disabled = false;
      if (r.ok) { clearDraft(d.msg); toast(`Sent to ${name()}`, 'ok'); setTimeout(refreshPeek, 600); }
      else toast(`Send to ${name()} failed: ${r.error || 'unknown error'}`, 'err');
    });
    d.panels.terminal = h('section', { class: 'd-panel', id: 'dpanel-terminal', role: 'tabpanel', 'aria-labelledby': 'dtab-terminal' },
      d.latest, term,
      h('div', { class: 'msg-wrap' }, h('h3', { class: 'h-sec', text: 'Message the worker' }), form,
        h('p', { class: 'hint', text: 'Goes straight into its terminal and skips the first mate. Use it for quick nudges.' })));
    d.updates = h('div');
    d.panels.updates = h('section', { class: 'd-panel', id: 'dpanel-updates', role: 'tabpanel', 'aria-labelledby': 'dtab-updates' }, d.updates);
    d.details = h('div', { class: 'task-info' });
    d.ordersList = h('ul', { class: 'list orders' });
    d.panels.details = h('section', { class: 'd-panel', id: 'dpanel-details', role: 'tabpanel', 'aria-labelledby': 'dtab-details' }, d.details);
    d.config = h('div', { class: 'config-sec' });
    d.panels.settings = h('section', { class: 'd-panel', id: 'dpanel-settings', role: 'tabpanel', 'aria-labelledby': 'dtab-settings' }, d.config);

    d.root = h('div', { class: 'task-drawer' }, d.file, d.decision, ...DRAWER_TABS.map(([k]) => d.panels[k]));
    ui.drawerBody.replaceChildren(d.root);
    ui.drawerBody.scrollTop = 0;
    for (const k of ['drawer-head', 'drawer-details', 'drawer-orders', 'drawer-decision', 'drawer-updates', 'drawer-resume', 'drawer-config']) sigs.delete(k);
    td = d;
    d.tabBtns.terminal.hidden = !t.window;
    showDrawerTab(store.get('drawerTab', 'terminal'));
    if (t.window) startPeek();
  }

  function renderTaskOrders(t) {
    const mine = ((snap.orders && snap.orders.list) || []).filter((o) => o.target === t.id || (o.targets && o.targets.includes(t.id)));
    if (unchanged('drawer-orders', t.id, mine)) return;
    td.ordersList.replaceChildren(...(mine.length ? mine.slice(0, 8).map(orderRow) : [emptyRow('No messages about this worker yet.')]));
  }

  // ---------- terminal peek ----------
  const PEEK_MS = 2000;
  let peekTimer = null;
  let peekBusy = false;
  function setPeekState(text, on) {
    if (!td) return;
    if (text !== undefined) { td.peekNote = text; td.peekOn = !!on; }
    td.peekState.textContent = td.paused ? 'Paused' : (td.peekNote || 'Connecting…');
    td.peekDot.classList.toggle('off', td.paused || !td.peekOn);
  }
  async function refreshPeek() {
    if (!td || peekBusy || td.paused || document.hidden || !td.file.hidden || td.tab !== 'terminal' || td.tabBtns.terminal.hidden) return;
    const d = td;
    peekBusy = true;
    try {
      const res = await fetch(`/api/peek/${encodeURIComponent(d.id)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (td !== d) return;
      const pre = d.peekText;
      if (res.ok) {
        if (d.peekRaw !== body.text || pre.classList.contains('peek-err')) { d.peekRaw = body.text; renderPeek(pre, body.text); }
        pre.classList.remove('peek-err');
        setPeekState(`Live, refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, true);
      } else {
        pre.textContent = body.error || `HTTP ${res.status}`;
        pre.classList.add('peek-err');
        setPeekState('Unavailable', false);
      }
      if (d.follow) pre.scrollTop = pre.scrollHeight;
    } catch {
      setPeekState('Offline', false);
    } finally {
      peekBusy = false;
    }
  }
  // Coloured spans from the pane text: class names and textContent only, never HTML.
  function renderPeek(pre, text) {
    const frag = document.createDocumentFragment();
    for (const seg of window.ShipDeckAnsi.parse(text)) {
      if (!seg.cls) { frag.append(seg.text); continue; }
      const span = document.createElement('span');
      span.className = seg.cls;
      span.textContent = seg.text;
      frag.append(span);
    }
    pre.replaceChildren(frag);
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
    d.fileTitle.textContent = name;
    d.fileMeta.textContent = 'Loading…';
    d.fileText.textContent = '';
    d.file.hidden = false;
    d.root.classList.add('viewing-file');
    ui.drawerBody.scrollTop = 0;
    try {
      const res = await fetch(`/api/file/${encodeURIComponent(id)}/${encodeURIComponent(name)}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      d.fileText.textContent = body.text;
      d.fileMeta.textContent = `${(body.size / 1024).toFixed(1)} KB${body.truncated ? ', truncated' : ''}, read-only`;
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

  // ---------- queue item, second mate and first mate drawers ----------
  function backlogItem() {
    const list = snap.backlog[selected.section] || (snap.backlog.calls || []).filter((c) => c.section === selected.section);
    const byIndex = list[selected.index];
    if (byIndex && itemKey(byIndex) === selected.id) return byIndex;
    return list.find((b) => itemKey(b) === selected.id);
  }
  // Queue tags in words; kind and hold-kind are parser bookkeeping and stay hidden.
  const TAG_WORDS = { repo: 'Project', since: 'Waiting since', after: 'Starts after', hold: 'On hold', reported: 'Reported', done: 'Done', added: 'Added', landed: 'Landed', due: 'Due', until: 'Until' };
  const HIDDEN_TAGS = new Set(['kind', 'hold-kind']);
  const DATE_TAG = new Set(['since', 'reported', 'done', 'added', 'landed', 'due', 'until']);

  function renderBacklogDrawer() {
    const b = backlogItem();
    const call = b && b.id ? (snap.backlog.calls || []).find((c) => c.id === b.id) : null;
    const st = call ? B.callStatus() : { captain: B.callStatus(), inFlight: { tone: 'working', flag: 'p', label: 'In progress' }, queued: { tone: 'waiting', flag: 'x', label: 'Up next in the queue' }, done: { tone: 'done', flag: 'c', label: 'Done' } }[selected.section] || { tone: 'waiting', flag: 'x', label: 'In the queue' };
    ui.drawerKicker.replaceChildren(pillEl(st), h('span', { text: 'From the queue' }));
    ui.drawerTitle.textContent = (b && b.title) || selected.id;
    if (!b) { ui.drawerSub.replaceChildren(); ui.drawerBody.replaceChildren(h('p', { text: 'This item is no longer in the queue.' })); return; }
    if (unchanged('drawer-backlog', selected.id, selected.section, b, call && call.options, (snap.orders && snap.orders.list || []).filter((o) => o.item === b.id))) return;
    ui.drawerSub.replaceChildren(h('div', { class: 'd-meta' }, ...[b.id ? h('code', { text: b.id }) : null, b.tags.repo ? h('span', { text: b.tags.repo }) : null].filter(Boolean)));
    const kids = [];
    if (call) {
      kids.push(h('section', { class: 'decision-sec tone-needs' },
        h('h3', null, flagEl('k'), 'Needs your answer'),
        b.tags.hold ? h('div', { class: 'decision-note', text: sentence(b.tags.hold) }) : null,
        answerPanel({
          options: call.options,
          draftKey: 'call.' + b.id,
          placeholder: call.options.length ? 'Optional note, or your own answer…' : 'Your answer…',
          send: (opt, extra) => answerCall(b, opt, extra),
        })));
    } else if (b.id && selected.section === 'queued' && !b.checked) {
      const note = persist(h('textarea', { rows: '2', maxlength: '2000', placeholder: 'Optional instructions for this job…', 'aria-label': 'Instructions' }), 'start.' + b.id);
      kids.push(h('section', { class: 'drawer-sec' },
        h('h3', { text: 'Start this' }),
        h('p', { class: 'hint', text: 'Asks the first mate to start a worker on this queue item.' }),
        h('div', { class: 'answer' }, note, h('div', { class: 'btn-row end' }, h('button', { class: 'btn primary', type: 'button', text: 'Start this', onclick: async () => {
          if (await startBacklog(b, note.value.trim() ? `Start ${b.id}: ${b.title}\n\n${note.value.trim()}` : null)) clearDraft(note);
        } })))));
    } else if (!b.id) {
      kids.push(h('p', { class: 'hint', text: 'This item has no id, so it cannot be started from here. Mention it in the chat instead.' }));
    }
    const dl = h('dl', { class: 'facts' });
    for (const [k, v] of Object.entries(b.tags || {})) {
      if (HIDDEN_TAGS.has(k) || (call && k === 'hold') || k === 'repo') continue;
      const value = k === 'after' ? titleOf(v) : DATE_TAG.has(k) ? shortDate(v) : v;
      fact(dl, TAG_WORDS[k] || sentence(k.replace(/-/g, ' ')), value.length > 600 ? value.slice(0, 600) + '…' : value);
    }
    if (dl.childNodes.length) kids.push(h('h3', { text: 'Details' }), dl);
    if (b.notes.length) kids.push(h('h3', { text: 'Notes' }), h('pre', { class: 'notes-block', text: b.notes.join('\n') }));
    const mine = ((snap.orders && snap.orders.list) || []).filter((o) => o.item === b.id);
    if (mine.length) kids.push(h('h3', { text: 'Messages about this item' }), h('ul', { class: 'list orders' }, ...mine.slice(0, 6).map(orderRow)));
    ui.drawerBody.replaceChildren(...kids);
    if (selected.focus) { selected.focus = false; const ta = ui.drawerBody.querySelector('textarea'); if (ta) ta.focus(); }
  }

  function renderSecondmateDrawer() {
    const r = (snap.secondmates.registry || []).find((x) => x.id === selected.id);
    ui.drawerKicker.replaceChildren(h('span', { class: 'pill plain', text: 'Second mate, not running' }));
    ui.drawerTitle.textContent = selected.id;
    ui.drawerSub.replaceChildren();
    if (!r) { ui.drawerBody.replaceChildren(h('p', { text: 'No longer registered.' })); return; }
    const dl = h('dl', { class: 'facts' });
    fact(dl, 'About', sentence(r.description));
    fact(dl, 'Scope', sentence(r.scope));
    fact(dl, 'Projects', r.projects);
    ui.drawerBody.replaceChildren(dl, h('p', { class: 'hint', text: 'The first mate starts it when its lane has work.' }));
  }

  // The first mate: monitoring, its own session, and every past worker session (Sessions
  // used to be a tab; now it lives here and in each worker's "Open in terminal").
  let fmSess = null; // { filter, list } while the first mate drawer is open
  function renderFirstMateDrawer() {
    ui.drawerKicker.replaceChildren(h('span', { class: 'pill plain' }, icon('i-helm'), 'At the helm'));
    ui.drawerTitle.textContent = 'First mate';
    const sess = snap.firstmate && snap.firstmate.session;
    if (unchanged('drawer-fm', sess, snap.watcher.healthy, !!snap.watcher.lastBeat, snap.orders && snap.orders.pending, snap.homeLabel) && fmSess && fmSess.list.isConnected) return;
    ui.drawerSub.replaceChildren();
    const dl = h('dl', { class: 'facts' });
    fact(dl, 'Fleet home', snap.homeLabel || snap.home, true);
    fact(dl, 'Monitoring', snap.watcher.lastBeat ? `${snap.watcher.healthy ? 'On' : 'Late'}, last check ${agoLong(snap.watcher.lastBeat)}` : 'Has not checked in');
    const pending = (snap.orders && snap.orders.pending) || 0;
    fact(dl, 'Not picked up yet', `${pending} message${pending === 1 ? '' : 's'}`);
    const filter = h('input', { class: 'input pane-filter', type: 'search', placeholder: 'Filter sessions…', 'aria-label': 'Filter sessions', autocomplete: 'off', spellcheck: 'false' });
    if (fmSess) filter.value = fmSess.filter.value;
    fmSess = { filter, list: h('ul', { class: 'list sessions' }) };
    filter.addEventListener('input', () => renderSessions(true));
    ui.drawerBody.replaceChildren(dl,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { closeDrawer(); showTab('bridge'); ui.chatText.focus(); } }, icon('i-chat'), 'Open the chat')),
      h('section', { class: 'drawer-sec' }, h('h3', { text: 'Open in terminal' }),
        h('p', { class: 'hint', text: 'The newest Claude Code session started in the fleet home.' }), resumeBlock(sess)),
      h('section', { class: 'drawer-sec' }, h('h3', { text: 'Past sessions' }),
        h('p', { class: 'hint', text: 'Every Claude Code session Ship Deck has matched to a worker, kept after cleanup. Copy a command into a terminal to resume it.' }),
        filter, fmSess.list));
    renderSessions(true);
    loadSessions(false);
  }

  function openDrawer(sel) {
    if (!selected || selected.type !== sel.type || selected.id !== sel.id) { stopPeek(); td = null; ui.drawerSub.replaceChildren(); }
    sigs.delete('drawer-backlog');
    sigs.delete('drawer-fm');
    const wantFocus = !!sel.focus;
    if (!selected) drawerBack = document.activeElement;
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
  let drawerBack = null; // where focus goes back to when the drawer closes
  function closeDrawer() {
    if (ui.drawer.contains(document.activeElement)) (drawerBack && drawerBack.isConnected ? drawerBack : ui.search).focus({ preventScroll: true });
    drawerBack = null;
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

  // ---------- views: Board (default) or Ship, remembered per viewer ----------
  let view = store.get('view') === 'ship' ? 'ship' : 'board';
  function setView(name) {
    view = name === 'ship' ? 'ship' : 'board';
    store.set('view', view);
    ui.board.hidden = view !== 'board';
    ui.scene.hidden = view !== 'ship';
    ui.viewBoard.setAttribute('aria-pressed', String(view === 'board'));
    ui.viewShip.setAttribute('aria-pressed', String(view === 'ship'));
    if (snap && !snap.firstRun) renderAll();
  }
  ui.viewBoard.addEventListener('click', () => setView('board'));
  ui.viewShip.addEventListener('click', () => setView('ship'));
  ui.fmWho.addEventListener('click', () => openFirstMate());
  // On narrow screens the panel sits under the board: jump down to the chat.
  ui.chatJump.addEventListener('click', () => {
    showTab('bridge');
    ui.panel.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    ui.chatText.focus({ preventScroll: true });
  });

  // ---------- resizable side panel ----------
  // The panel width lives in --panel-w on .layout; CSS clamps it to 320px..70vw.
  const PANEL_MIN = 320;
  const PANEL_DEFAULT = 420;
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
  // Activity kind -> sprite icon (line icons, no emoji).
  const ACT_ICON = { shell: 'i-term', browser: 'i-globe', read: 'i-eye', edit: 'i-pencil', write: 'i-file', agent: 'i-people', publish: 'i-send', tool: 'i-bolt', text: 'i-chat', session: 'i-anchor' };
  const actIcon = (e) => ACT_ICON[e.kind === 'text' ? 'text' : e.icon] || ACT_ICON.tool;
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
  function clockSec(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
  function dur(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    return Math.floor(ms / 60000) + 'm' + String(Math.round((ms % 60000) / 1000)).padStart(2, '0') + 's';
  }
  function evStatus(e) {
    if (e.kind !== 'tool') return null;
    const text = { running: 'Running', done: dur(e.duration), failed: `Failed${e.duration !== null && e.duration !== undefined ? ', ' + dur(e.duration) : ''}`, unknown: 'No result' }[e.status] || '';
    return h('span', { class: 'ev-status st-' + e.status, title: e.status === 'unknown' ? 'No result recorded (session changed)' : null, text });
  }
  function evRow(e) {
    if (e.kind === 'session') return h('li', { class: 'ev-session' }, icon(ACT_ICON.session), h('span', { text: e.label }));
    let main;
    if (e.detail) {
      const d = h('details', { class: 'ev-cmd', ontoggle: () => (d.open ? expanded.add(e.seq) : expanded.delete(e.seq)) },
        h('summary', { title: 'Show the command' }, e.label, ' ', icon('i-chev')), h('pre', { class: 'mono', text: e.detail }));
      d.open = expanded.has(e.seq);
      main = d;
    } else main = h('span', { class: 'ev-label', text: e.kind === 'text' ? `“${e.label}”` : e.label });
    return h('li', { class: `ev ev-${e.kind}` + (e.status ? ' st-' + e.status : '') },
      icon(actIcon(e), 'ev-icon'),
      h('div', { class: 'ev-main' }, main),
      h('span', { class: 'ev-side' }, evStatus(e), h('time', { class: 'ev-time', text: clockSec(e.ts) })));
  }
  function renderActivity() {
    const has = act.loaded && !!act.sessionId;
    const label = !has ? 'no session' : act.working ? 'working…' : 'idle';
    ui.activityDot.hidden = !act.working;
    renderHealth();
    ui.activitySub.textContent = has
      ? `Live from the first mate's Claude Code transcript (read-only). Last line ${act.lastAt ? agoLong(act.lastAt) : 'unknown'}.`
      : act.loaded ? 'No first mate Claude Code transcript found yet.' : 'Loading…';
    const list = [...act.events.values()].sort((a, b) => b.seq - a.seq);
    const latest = list.find((e) => e.kind === 'tool' || e.kind === 'text');
    // Panel head: what the first mate is doing right now.
    ui.fmLive.classList.toggle('off', !act.working);
    ui.fmNowText.textContent = !has ? (act.loaded ? 'No session found' : 'Loading…')
      : act.working ? `Working: ${latest && latest.kind === 'tool' ? latest.label.charAt(0).toLowerCase() + latest.label.slice(1) : 'thinking'}`
        : `Idle, last active ${act.lastAt ? agoLong(act.lastAt) : 'a while ago'}`;
    ui.workingNow.hidden = !(has && act.working);
    if (has && act.working) ui.workingNowText.textContent = `First mate is ${latest && latest.kind === 'tool' ? latest.label.charAt(0).toLowerCase() + latest.label.slice(1) : 'thinking'}`;
    ui.fmShipNow.textContent = ui.fmNowText.textContent;
    if (activeTab !== 'activity' || unchanged('feed', act.epoch, act.rev, list.length)) return;
    ui.feed.replaceChildren(...(list.length ? list.map(evRow) : [emptyRow(has ? 'No tool calls in the transcript yet.' : 'Nothing to show until the first mate has a Claude Code session in its home.')]));
  }

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

  // Kind -> icon on an action card in the chat.
  const KIND_ICON = { merge: 'i-pr', cleanup: 'i-check', 'cleanup-done': 'i-check', status: 'i-eye', 'new-task': 'i-plus', 'backlog-start': 'i-chev', config: 'i-bolt' };
  // One receipt line under the captain's chat bubble: Answered / Seen / Sent, not seen yet.
  function receipt(x) {
    const at = (st) => (x.history || []).find((a) => a.status === st);
    const t = (a) => (a && a.ts ? ' ' + clock(timeOf(a.ts)) : '');
    if (x.status === 'done') return h('span', { class: 'receipt done' }, icon('i-check'), `Answered${t(at('done'))}`);
    if (x.status === 'declined') return h('span', { class: 'receipt no' }, icon('i-x'), `Declined${t(at('declined'))}`);
    if (x.status === 'acknowledged') return h('span', { class: 'receipt' }, icon('i-eye'), `Seen${t(at('acknowledged'))}`);
    return h('span', { class: 'receipt wait' }, icon('i-dash'), `Sent ${clock(timeOf(x.ts))}, not seen yet`);
  }
  // The worker an order names, as a chip with its flag.
  function refChip(id) {
    const t = snap && snap.tasks.find((w) => w.id === id);
    const st = t ? taskStatus(t) : null;
    return h('button', { class: 'ref', type: 'button', title: t ? `${st.label}: open details` : id, onclick: () => (t ? openDrawer({ type: 'task', id }) : null), disabled: !t },
      st ? flagEl(st.flag) : null, titleOf(id));
  }
  function threadItem(x, prev, byId) {
    const when = timeOf(x.ts);
    const stampEl = h('time', { datetime: x.ts || '', title: x.ts ? new Date(when).toLocaleString() : '', text: clock(when) });
    if (x.type === 'reply') {
      const body = h('div', { class: 'bubble md' });
      body.innerHTML = MD.render(x.text, { breaks: true }); // escaped by the renderer
      const ref = x.inReplyTo && byId.get(x.inReplyTo);
      const quote = ref && !(prev && prev.id === ref.id)
        ? h('button', { class: 'quote', type: 'button', title: 'Show the message this answers', onclick: () => flashMessage(ref.id) }, 'Re: ', excerpt(ref.text || L.kindLabel(ref.kind), 70))
        : null;
      const unread = !seenId || x.id > seenId;
      return h('li', { class: 'msg mate' + (unread && seenId !== null ? ' unread' : ''), 'data-id': x.id },
        h('span', { class: 'fm-avatar small', 'aria-hidden': 'true' }, icon('i-helm')),
        h('div', { class: 'msg-col' }, h('div', { class: 'msg-meta' }, h('strong', { text: 'First mate' }), stampEl), quote, x.text ? body : null, attachmentsBlock(x.attachments)));
    }
    if (x.kind === 'chat') {
      return h('li', { class: 'msg captain', 'data-id': x.id },
        h('div', { class: 'msg-col' },
          h('div', { class: 'bubble' + (x.text ? '' : ' bare'), title: x.ts ? `Sent ${new Date(when).toLocaleString()}` : null }, x.text ? h('div', { class: 'bubble-text', text: x.text }) : null, attachmentsBlock(x.attachments)),
          receipt(x)));
    }
    // Any other order is an action card: what was asked, about whom, and how far it got.
    const extra = payloadText(x);
    return h('li', { class: 'msg captain action', 'data-id': x.id },
      h('div', { class: 'action-card' },
        h('div', { class: 'ac-head' }, x.kind === 'decision' || x.kind === 'backlog-answer' ? flagEl('k') : icon(KIND_ICON[x.kind] || 'i-chat'),
          h('span', { text: L.kindLabel(x.kind) }), x.target ? refChip(x.target) : null),
        extra ? h('div', { class: 'ac-extra', text: extra }) : null,
        x.text ? h('div', { class: 'ac-text', text: x.text }) : null,
        attachmentsBlock(x.attachments),
        lifecycle(x)));
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
        h('p', { class: 'hint', text: 'Ask the first mate anything: “what needs me?”, “start the monitoring fix”, “summarise PR 42”. Every message goes to the first mate, and replies show up here.' })));
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
          h('button', { class: 'att-x', type: 'button', 'aria-label': `Remove ${a.name}`, title: 'Remove', onclick: () => removeAttachment(a) }, icon('i-x')));
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
    ui.suggest.hidden = !!ui.chatText.value.trim() || outgoing.length > 0; // suggestions only for an empty composer
    ui.chatSend.disabled = busy;
    ui.chatHint.textContent = busy ? 'Waiting for attachments…' : 'Enter to send, Shift+Enter for a new line';
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
        h('figcaption', null, a.name, ', ', stills));
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

  // Suggestions fill the box (never send on their own).
  ui.suggest.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-text]');
    if (!b) return;
    ui.chatText.value = b.dataset.text;
    ui.chatText.dispatchEvent(new Event('input'));
    ui.chatText.focus();
  });
  persist(ui.chatText, 'chat');
  ui.chatText.addEventListener('input', updateSendState);
  updateSendState();
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
    ui.notifyBtn.title = p === 'denied' ? 'Notifications are blocked for this site in the browser settings' : 'Browser notifications for new replies and items that need you';
  }
  ui.notifyBtn.addEventListener('click', async () => {
    if (!canNotify) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    } else if (Notification.permission === 'granted') {
      notify('Ship Deck alerts are on', 'You will be told about new first mate replies and new items that need you.', 'shipdeck-test');
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
  // New "needs you" items: workers entering decision/blocked/failed, or new queue decisions.
  function notifyNeeds() {
    const now = [
      ...needsCaptain().map((t) => ({ key: `t:${t.id}:${t.state}:${t.statusCount}`, title: `${t.title || t.id} needs you`, body: L.summary(t), open: () => openDrawer({ type: 'task', id: t.id }) })),
      ...(snap.backlog.calls || []).filter((b) => b.id).map((b) => ({ key: `c:${b.id}`, title: `Needs you: ${b.title || b.id}`, body: b.id, open: () => openDrawer({ type: 'backlog', id: b.id, section: b.section, index: b.index }) })),
    ];
    const seen = store.json('seenNeeds', null);
    store.set('seenNeeds', JSON.stringify(now.map((x) => x.key)));
    if (!seen) return;
    const fresh = now.filter((x) => !seen.includes(x.key));
    if (!fresh.length) return;
    toast(fresh.length > 1 ? `${fresh.length} new items need you` : fresh[0].title, 'ok');
    if (fresh.length === 1) notify(fresh[0].title, fresh[0].body, 'shipdeck-needs', fresh[0].open);
    else notify(`${fresh.length} new items need you`, fresh.map((x) => x.title).join('\n'), 'shipdeck-needs', () => setView('board'));
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
  function renderSessions(force) {
    if (!sessionEntries || !fmSess || !fmSess.list.isConnected) return;
    const q = fmSess.filter.value.trim().toLowerCase();
    const list = sessionEntries.filter((e) => !e.firstmate && (!q || [e.id, titleOf(e.id), e.sessionId, e.harness].join(' ').toLowerCase().includes(q)));
    if (unchanged('sessions', list, q) && !force) return;
    fmSess.list.replaceChildren(...(list.length ? list.map((e) => {
      const name = titleOf(e.id);
      return h('li', { class: 'session' + (e.present ? '' : ' departed') },
        h('div', { class: 'session-head' },
          e.present
            ? h('button', { class: 'linkish', type: 'button', text: name, onclick: () => openDrawer({ type: 'task', id: e.id }) })
            : h('span', { class: 'strong', text: name }),
          name !== e.id ? h('code', { class: 'muted', text: e.id }) : null,
          h('span', { class: 'pill sm ' + (e.present ? 'tone-working' : 'plain'), text: e.present ? 'Aboard' : 'Cleaned up' }),
          h('span', { class: 'r-age', text: e.lastSeen ? `Seen ${agoLong(e.lastSeen)}` : '' })),
        resumeBlock(e));
    }) : [emptyRow(sessionEntries.length ? 'No sessions match.' : 'No sessions recorded yet. Ship Deck records Claude Code sessions as it finds them.')]));
  }

  // ---------- health strip ----------
  // First mate listening (transcript activity < 2 min), Monitoring, Updated; "Deck offline" only when it is.
  function setHealth(el, cls, text, title) {
    el.classList.remove('ok', 'warn', 'err');
    if (cls) el.classList.add(cls);
    el.querySelector('.health-text').textContent = text;
    if (title) el.title = title;
  }
  function renderHealth() {
    if (!snap || snap.firstRun) return;
    const fmAt = act.lastAt;
    const listening = act.working || (fmAt && Date.now() - fmAt < LISTENING_MS);
    setHealth(ui.healthFm, listening ? 'ok' : act.loaded && !act.sessionId ? 'err' : null,
      listening ? 'First mate listening' : act.loaded && !act.sessionId ? 'First mate not found' : 'First mate quiet',
      fmAt ? `Last first mate activity ${agoLong(fmAt)}` : 'No first mate activity seen yet');
    const w = snap.watcher;
    setHealth(ui.healthMon, w.lastBeat ? (w.healthy ? 'ok' : 'warn') : 'err',
      w.lastBeat ? (w.healthy ? 'Monitoring on' : 'Monitoring late') : 'Not monitoring',
      w.lastBeat ? `Last monitoring check ${agoLong(w.lastBeat)}` : 'Monitoring has not checked in');
    ui.healthTime.textContent = lastOkAt ? `Updated ${new Date(lastOkAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';
  }

  // First run: the server found no firstmate home, so explain how to point it at one.
  function renderFirstRun() {
    document.body.classList.add('first-run-mode');
    ui.firstRun.hidden = false;
    ui.home.textContent = 'No firstmate folder yet';
    ui.firstRunChecked.replaceChildren(...['The --home flag', 'The FM_HOME variable', ...(snap.checked || [])].map((p, i) =>
      h('li', null, h('span', { class: 'ic todo' }, icon('i-dash')), h('div', null, i < 2 ? h('b', { text: p }) : h('code', { text: p }), h('span', { text: i < 2 ? 'Not set' : 'Not a firstmate folder' })))));
    ui.healthFm.hidden = true;
    ui.healthMon.hidden = true;
  }
  $('fr-copy').addEventListener('click', (e) => copyText($('fr-cmd').textContent, e.currentTarget));

  // ---------- wiring ----------
  function renderAll() {
    if (!snap) return;
    if (snap.firstRun) return renderFirstRun();
    ui.home.textContent = snap.homeLabel || snap.home;
    ui.home.title = `Firstmate home (read-only): ${snap.home}`;
    if (view === 'board') renderBoard();
    else {
      renderBridge();
      renderDeck();
      renderCabins();
      renderHold();
      firstRender = false;
    }
    renderDrawer();
  }

  function setSync(ok, text) {
    ui.sync.classList.toggle('ok', ok);
    ui.sync.classList.toggle('err', !ok);
    ui.syncText.textContent = text;
    ui.sync.hidden = ok; // the strip only mentions the deck itself when it is offline
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
      if (!snap.firstRun && document.body.classList.contains('first-run-mode')) { location.reload(); return; } // restarted with a home
      failures = 0;
      renderAll();
      setSync(true, 'Deck running');
      renderHealth();
      if (snap.firstRun) { timer = setTimeout(poll, 10000); return; }
      if (snap.thread && snap.thread.sig !== threadSig) loadThread(snap.thread.sig);
      notifyNeeds();
      loadActivity();
      if (firstHash) { const id = firstHash; firstHash = null; if (snap.tasks.some((t) => t.id === id)) openDrawer({ type: 'task', id }); }
    } catch (e) {
      if (!(e instanceof TypeError && /fetch|network/i.test(e.message)) && !/^HTTP /.test(e.message)) console.error('Ship Deck render failed:', e);
      failures++;
      delay = Math.min(15000, POLL_MS * Math.pow(1.6, failures - 1));
      setSync(false, 'Deck offline');
      ui.healthTime.textContent = lastOkAt ? `Last update ${new Date(lastOkAt).toLocaleTimeString()}` : '';
      showReconnect(delay);
    }
    timer = setTimeout(poll, delay);
  }
  ui.reconnectNow.addEventListener('click', () => { ui.reconnectText.textContent = 'Reconnecting…'; poll(); });

  let firstHash = (/^#task=(.+)$/.exec(location.hash) || [])[1];
  if (firstHash) firstHash = decodeURIComponent(firstHash);

  ui.search.addEventListener('input', () => { query = ui.search.value.trim().toLowerCase(); renderAll(); });
  // ---------- keyboard: shortcuts and the "?" sheet ----------
  // The sheet is built from this list, so it always matches what the keys do.
  const SHORTCUTS = [
    ['Get around', [
      [['/'], 'Filter the board'], [['⌘', 'K'], 'Filter (also Ctrl+K)'],
      [['G', 'then', 'B'], 'Board view'], [['G', 'then', 'S'], 'Ship view'],
      [['G', 'then', 'C'], 'Chat with the first mate'], [['G', 'then', 'A'], 'First mate activity'],
      [['G', 'then', 'L'], "Ship's Library"], [['Esc'], 'Close or go back'],
    ]],
    ['On the board', [
      [['J', 'K'], 'Next or previous card'], [['←', '→'], 'Previous or next column'],
      [['Enter'], 'Open the selected card'], [['N'], 'Next thing that needs you'],
      [['A', '…', 'H'], 'Pick an option on the selected card'],
    ]],
    ['In a worker', [
      [['1', '2', '3', '4'], 'Switch tab (terminal to settings)'],
      [['W'], 'Wrap long lines'], [['F'], 'Follow new output'],
      [['O'], 'Open the pull request'], [['M'], 'Message the worker'],
    ]],
    ['Chat', [
      [['Enter'], 'Send'], [['Shift', 'Enter'], 'New line'], [['⌘', 'V'], 'Paste a screenshot'],
    ]],
  ];
  function renderShortcuts() {
    const keys = (list) => h('span', { class: 'keys' }, ...list.map((k) => (k === 'then' || k === '…' ? h('span', { text: k }) : h('span', { class: 'kbd', text: k }))));
    const group = ([title, rows]) => h('div', { class: 'sc-group' }, h('h3', { text: title }), ...rows.map(([k, what]) => h('div', { class: 'sc' }, h('span', { text: what }), keys(k))));
    const flags = h('div', { class: 'sc-group' }, h('h3', { text: 'What the flags mean' }), h('div', { class: 'sc-flags' },
      ...B.TONE_ORDER.map((tone) => h('div', null, flagEl(B.TONES[tone].flag, 'lg'), h('b', { text: B.TONES[tone].word }), h('i', { text: B.TONES[tone].meaning })))));
    ui.shortcutsBody.replaceChildren(h('div', null, group(SHORTCUTS[0]), group(SHORTCUTS[1])), h('div', null, group(SHORTCUTS[2]), group(SHORTCUTS[3]), flags));
  }
  let shortcutsBack = null;
  function openShortcuts() {
    if (!ui.shortcutsBody.childElementCount) renderShortcuts();
    shortcutsBack = document.activeElement;
    ui.shortcuts.hidden = false;
    ui.shortcutsScrim.hidden = false;
    ui.shortcuts.focus();
  }
  function closeShortcuts() {
    ui.shortcuts.hidden = true;
    ui.shortcutsScrim.hidden = true;
    if (shortcutsBack && shortcutsBack.isConnected) shortcutsBack.focus({ preventScroll: true });
  }
  ui.helpBtn.addEventListener('click', openShortcuts);
  ui.shortcutsClose.addEventListener('click', closeShortcuts);
  ui.shortcutsScrim.addEventListener('click', closeShortcuts);

  // Cards (board) or berths (ship) in reading order, column by column.
  function navItems() {
    if (view === 'ship') return [...ui.areas.querySelectorAll('.berth:not(.hidden-by-filter)')];
    return [...ui.cols.querySelectorAll('.card-link')];
  }
  function currentItem(items) {
    const a = document.activeElement;
    return items.findIndex((el) => el === a || (a && el.closest('.bcard, .row-card') && el.closest('.bcard, .row-card').contains(a)));
  }
  function focusItem(el) {
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function moveColumn(dir) {
    const cols = [...ui.cols.querySelectorAll('.col')];
    const here = document.activeElement && document.activeElement.closest('.col');
    let i = cols.indexOf(here);
    for (let n = 0; n < cols.length; n++) {
      i = i < 0 ? 0 : (i + dir + cols.length) % cols.length;
      const first = cols[i].querySelector('.card-link');
      if (first) return focusItem(first);
    }
  }
  const modalOpen = () => !ui.lightbox.hidden || !!confirmResolve || !ui.library.hidden || !ui.jobSheet.hidden || !ui.shortcuts.hidden;
  const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  let gPending = 0;
  document.addEventListener('keydown', (e) => {
    const typing = editable(document.activeElement);
    if (e.key === 'Escape') {
      if (!ui.lightbox.hidden) closeLightbox();
      else if (confirmResolve) confirmResolve(false);
      else if (!ui.shortcuts.hidden) closeShortcuts();
      else if (!ui.jobSheet.hidden) closeJobSheet();
      else if (!ui.library.hidden) closeLibrary();
      else if (selected && closeDataFile()) { /* back to the worker */ }
      else if (selected) closeDrawer();
      else if (document.activeElement === ui.search && ui.search.value) { ui.search.value = ''; query = ''; renderAll(); }
      else if (typing) document.activeElement.blur();
      return;
    }
    if (e.key === 'Enter' && confirmResolve && !typing && document.activeElement !== ui.confirmNo) {
      e.preventDefault();
      confirmResolve(true);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k' && !modalOpen()) {
      e.preventDefault();
      ui.search.focus();
      ui.search.select();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); if (ui.shortcuts.hidden) { if (!modalOpen()) openShortcuts(); } else closeShortcuts(); return; }
    if (modalOpen()) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === '/') {
      e.preventDefault();
      ui.search.focus();
      ui.search.select();
      return;
    }
    if (gPending && Date.now() - gPending < 1500) {
      gPending = 0;
      const go = { b: () => setView('board'), s: () => setView('ship'), c: () => { showTab('bridge'); ui.chatText.focus(); }, a: () => showTab('activity'), l: () => openLibrary() }[k];
      if (go) { e.preventDefault(); if (selected && k !== 'c' && k !== 'a') closeDrawer(); go(); }
      return;
    }
    const optCard = document.activeElement && document.activeElement.closest('.bcard');
    if (k === 'g' && !(optCard && optCard.querySelector('.opt[data-letter="G"]'))) { gPending = Date.now(); return; }
    // In an open worker drawer.
    if (selected && selected.type === 'task' && td) {
      const tab = { 1: 'terminal', 2: 'updates', 3: 'details', 4: 'settings' }[k];
      if (tab) { e.preventDefault(); showDrawerTab(tab); td.tabBtns[td.tab].focus(); return; }
      if (k === 'w' || k === 'f') { e.preventDefault(); showDrawerTab('terminal'); (k === 'w' ? td.wrapBtn : td.followBtn).click(); return; }
      if (k === 'o' && td.prLink) { e.preventDefault(); window.open(td.prLink, '_blank', 'noopener,noreferrer'); return; }
      if (k === 'm' && !td.tabBtns.terminal.hidden) { e.preventDefault(); showDrawerTab('terminal'); td.msg.focus(); return; }
      return;
    }
    if (selected) return;
    // On the board or the ship.
    const items = navItems();
    if (k === 'j' || k === 'k') {
      e.preventDefault();
      const i = currentItem(items);
      focusItem(items[i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + (k === 'j' ? 1 : -1)))]);
    } else if ((k === 'ArrowRight' || k === 'ArrowLeft') && view === 'board' && (currentItem(items) >= 0 || document.activeElement === document.body)) {
      e.preventDefault();
      moveColumn(k === 'ArrowRight' ? 1 : -1);
    } else if (k === 'n') {
      e.preventDefault();
      if (view !== 'board') setView('board');
      const needs = [...ui.cols.querySelectorAll('.col[data-col="needs"] .card-link')];
      if (!needs.length) { toast('Nothing needs you right now', 'ok'); return; }
      const i = needs.indexOf(document.activeElement);
      focusItem(needs[(i + 1) % needs.length]);
    } else if (/^[a-h]$/.test(k) && view === 'board') {
      const card = document.activeElement && document.activeElement.closest('.bcard');
      const opt = card && card.querySelector(`.opt[data-letter="${k.toUpperCase()}"]`);
      if (opt) { e.preventDefault(); opt.click(); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); refreshPeek(); markSeen(); } });

  // ---------- ship's library (read-only) ----------
  let libEntries = [];
  let libKey = null;
  let libSharing = true;

  function renderLibraryList() {
    const q = ui.libraryFilter.value.trim().toLowerCase();
    const shown = libEntries.filter((e) => !q || [e.group, e.title, e.label, e.description].join(' ').toLowerCase().includes(q));
    const groups = [];
    for (const e of shown) {
      let g = groups.find((x) => x.name === e.group);
      if (!g) { g = { name: e.group, items: [] }; groups.push(g); }
      g.items.push(e);
    }
    ui.libraryList.replaceChildren(...(groups.length ? groups.map((g) => h('div', { class: 'lib-group' },
      h('h3', null, g.name, h('span', { class: 'count', text: g.items.length })),
      h('ul', { class: 'lib-items' }, ...g.items.map((e) => h('li', null, h('button', {
        class: 'lib-item' + (e.exists ? '' : ' missing') + (e.key === libKey ? ' active' : '') + (e.description !== undefined ? ' skill' : ''), type: 'button',
        'aria-current': e.key === libKey ? 'true' : null, title: e.where || e.label,
        onclick: () => openLibraryEntry(e.key),
      }, h('span', { class: 'lib-line' }, h('span', { class: 'lib-name', text: e.title || e.label }), h('span', { class: 'lib-age', text: e.exists ? agoLong(e.mtime) : 'Not created yet' })),
      e.description ? h('span', { class: 'lib-desc', text: e.description }) : h('span', { class: 'lib-desc mono', text: e.where || e.label }))))))) : [h('p', { class: 'empty', text: 'Nothing matches.' })]),
    ...(libSharing ? [] : [h('p', { class: 'hint' }, 'Sharing is off, so skills teammates share with you do not arrive. Turn it back on with ', h('code', { text: 'sh ~/ship-deck/bin/install.sh --share' }), ' and restart Ship Deck.')]));
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
        h('h2', { text: e.title || e.label }),
        isSkill && e.description ? h('p', { class: 'doc-desc', text: e.description }) : null,
        h('p', { class: 'doc-meta' }, h('code', { text: e.where || e.label }), e.exists
          ? `, changed ${whenText(e.mtime)}, ${(e.size / 1024).toFixed(1)} KB${body.truncated ? ', truncated' : ''}` : ''));
      if (body.text === null) {
        ui.libraryDoc.replaceChildren(head, h('div', { class: 'doc-missing' }, h('strong', { text: 'Not created yet' }), h('span', { text: 'The first mate has not written this file. It shows up here once it does.' })));
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
      const body = await res.json();
      libEntries = body.entries || [];
      libSharing = body.sharing !== false;
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

  // Notifications button, remembered tab, then the first poll.
  renderNotifyBtn();
  showTab(store.get('tab', 'bridge'));
  setView(view);
  poll();
})();
