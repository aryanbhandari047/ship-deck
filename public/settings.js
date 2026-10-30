'use strict';
// Settings > You: the form of address the deck and the first mate use (GET/POST /api/settings).

(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('address');
  const save = $('address-save');
  const status = $('address-status');
  const preview = $('address-preview');
  const tell = $('address-tell');
  let saved = null;

  function hello() {
    const hr = new Date().getHours();
    return hr < 5 ? 'On the night watch' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  }
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  function render() {
    const v = clean(input.value);
    preview.textContent = v ? `${hello()}, ${v}` : hello();
    save.disabled = saved === null || v === saved;
    for (const b of document.querySelectorAll('#address-suggest button')) b.setAttribute('aria-pressed', String(b.dataset.value === v));
  }
  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.textContent = text;
    $('toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, kind === 'err' ? 7000 : 3500);
  }

  async function load() {
    try {
      const r = await (await fetch('/api/settings', { cache: 'no-store' })).json();
      saved = typeof r.address === 'string' ? r.address : 'Captain';
      input.value = saved;
      input.maxLength = r.max || 40;
      $('address-suggest').replaceChildren(...(r.suggestions || ['Captain', 'Boss', '']).map((v) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'filter';
        b.dataset.value = v;
        b.textContent = v || 'No title';
        b.addEventListener('click', () => { input.value = v; render(); input.focus(); });
        return b;
      }));
    } catch {
      status.textContent = 'Could not load your settings. Is Ship Deck running?';
    }
    render();
  }

  input.addEventListener('input', render);
  $('address-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const address = clean(input.value);
    save.disabled = true;
    status.textContent = 'Saving…';
    let r;
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: JSON.stringify({ address, tell: tell.checked }) });
      r = await res.json();
    } catch {
      r = { ok: false, error: 'Ship Deck is not reachable' };
    }
    if (!r.ok) {
      status.textContent = '';
      toast(`Not saved: ${r.error}`, 'err');
      render();
      return;
    }
    saved = r.settings.address;
    input.value = saved;
    status.textContent = r.order ? 'Saved. The first mate has been told.' : 'Saved.';
    toast(saved ? `Ship Deck will call you ${saved}` : 'Ship Deck will skip the title', 'ok');
    render();
  });
  load();
})();
