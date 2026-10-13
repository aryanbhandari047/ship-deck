'use strict';
// Terminal peek colours: turns `tmux capture-pane -e` text into [{ text, cls }] segments.
// Only SGR colour/style codes survive, as class names; every other escape or control is dropped.

(function (root) {
  // CSI (params, intermediates, final), OSC/DCS/APC/PM/SOS strings (BEL or ST end), charset and
  // other ESC sequences, and an unterminated sequence at the very end.
  const ESC_RE = /\x1b\[([\x30-\x3f]*)[\x20-\x2f]*([\x40-\x7e])|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|\x1b[\]PX^_][\s\S]*$|\x1b\[[\x20-\x3f]*$|\x1b[\x20-\x2f]+[\x30-\x7e]?|\x1b[\s\S]?/g;
  const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g; // keeps \t and \n
  const MAX_PARAMS = 32;

  // A 0-255 RGB triple to the nearest of the 16 base colours (bright when any channel is strong).
  function rgbTo16(r, g, b) {
    const max = Math.max(r, g, b);
    if (max - Math.min(r, g, b) < 24) return max < 64 ? 0 : max < 150 ? 8 : max < 215 ? 7 : 15;
    const on = (c) => (c >= max * 0.65 ? 1 : 0);
    return (on(r) | (on(g) << 1) | (on(b) << 2)) + (max >= 200 ? 8 : 0);
  }
  function xterm256(n) {
    if (n < 16) return n;
    if (n >= 232) { const v = 8 + (n - 232) * 10; return rgbTo16(v, v, v); }
    const c = n - 16, lv = (x) => (x ? 55 + x * 40 : 0);
    return rgbTo16(lv(Math.floor(c / 36)), lv(Math.floor(c / 6) % 6), lv(c % 6));
  }

  // Applies one SGR parameter list to state; returns nothing, mutates st.
  function applySgr(st, raw) {
    if (!/^[\d;:]*$/.test(raw)) return; // private or malformed: ignore
    const p = raw.split(/[;:]/).slice(0, MAX_PARAMS).map((x) => (x === '' ? 0 : Math.min(Number(x), 9999)));
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) Object.assign(st, { fg: null, bg: null, b: false, d: false, i: false, u: false, s: false, inv: false });
      else if (n === 1) st.b = true;
      else if (n === 2) st.d = true;
      else if (n === 3) st.i = true;
      else if (n === 4) st.u = true;
      else if (n === 7) st.inv = true;
      else if (n === 9) st.s = true;
      else if (n === 22) st.b = st.d = false;
      else if (n === 23) st.i = false;
      else if (n === 24) st.u = false;
      else if (n === 27) st.inv = false;
      else if (n === 29) st.s = false;
      else if (n >= 30 && n <= 37) st.fg = n - 30;
      else if (n === 39) st.fg = null;
      else if (n >= 40 && n <= 47) st.bg = n - 40;
      else if (n === 49) st.bg = null;
      else if (n >= 90 && n <= 97) st.fg = n - 90 + 8;
      else if (n >= 100 && n <= 107) st.bg = n - 100 + 8;
      else if (n === 38 || n === 48) {
        let c = null;
        if (p[i + 1] === 5 && i + 2 < p.length) { c = p[i + 2] <= 255 ? xterm256(p[i + 2]) : null; i += 2; }
        else if (p[i + 1] === 2 && i + 4 < p.length) { c = p.slice(i + 2, i + 5).every((v) => v <= 255) ? rgbTo16(p[i + 2], p[i + 3], p[i + 4]) : null; i += 4; }
        else break; // truncated extended colour: drop the rest of the list
        if (n === 38) st.fg = c; else st.bg = c;
      }
    }
  }

  function classOf(st) {
    const fg = st.inv ? (st.bg === null ? 'rev' : st.bg) : st.fg;
    const bg = st.inv ? (st.fg === null ? 'rev' : st.fg) : st.bg;
    const out = [];
    if (fg !== null) out.push('fg-' + fg);
    if (bg !== null) out.push('bg-' + bg);
    for (const k of ['b', 'd', 'i', 'u', 's']) if (st[k]) out.push('t-' + k);
    return out.join(' ');
  }

  // [{ text, cls }] with adjacent equal classes merged; cls is '' for default text.
  function parse(input) {
    const src = String(input == null ? '' : input);
    const st = { fg: null, bg: null, b: false, d: false, i: false, u: false, s: false, inv: false };
    const segs = [];
    const push = (text) => {
      text = text.replace(CTRL_RE, '');
      if (!text) return;
      const cls = classOf(st);
      const last = segs[segs.length - 1];
      if (last && last.cls === cls) last.text += text; else segs.push({ text, cls });
    };
    let at = 0, m;
    ESC_RE.lastIndex = 0;
    while ((m = ESC_RE.exec(src))) {
      push(src.slice(at, m.index));
      at = ESC_RE.lastIndex;
      if (m[2] === 'm') applySgr(st, m[1]);
    }
    push(src.slice(at));
    return segs;
  }

  const api = { parse, xterm256, rgbTo16 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShipDeckAnsi = api;
})(typeof window !== 'undefined' ? window : globalThis);
