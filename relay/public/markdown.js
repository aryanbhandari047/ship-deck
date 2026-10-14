'use strict';
// Small, safe markdown renderer shared by the Bridge chat and the Ship's Library.
// Every source character is HTML-escaped first; links are http(s) only.

(function (root) {
  function esc(s) {
    return String(s).replace(/\u0000/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Inline markdown on already-escaped text. Code spans and links are held out
  // as placeholders so emphasis never lands inside them.
  function inline(s) {
    const held = [];
    const hold = (html) => { held.push(html); return `\u0000${held.length - 1}\u0000`; };
    const link = (u, t) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t));
    s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => {
      const m = /^(.*?)((?:[.,;:!?]|&#39;|&quot;)*)$/.exec(u); // keep trailing punctuation outside the link
      return pre + link(m[1], m[1]) + m[2];
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    for (let i = 0; i < 3 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[n]);
    return s;
  }

  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function render(src, opts) {
    const o = opts || {};
    let text = String(src === undefined || src === null ? '' : src);
    const out = [];
    // YAML frontmatter shows as a small definition list (or not at all with frontmatter: 'hide').
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (fm) text = text.slice(fm[0].length);
    if (fm && o.frontmatter !== 'hide') {
      const rows = [];
      for (const l of fm[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l);
        if (kv) rows.push([kv[1], kv[2]]);
        else if (rows.length && l.trim()) rows[rows.length - 1][1] += ' ' + l.trim();
      }
      if (rows.length) out.push(`<dl class="md-front">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${inline(esc(v.replace(/^["']|["']$/g, '')))}</dd>`).join('')}</dl>`);
    }
    const lines = esc(text).split(/\r?\n/);
    let para = [];
    const lists = []; // open lists, outermost first: { kind: 'ul' | 'ol', indent }
    let quote = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(o.breaks ? '<br>' : ' '))}</p>`); para = []; } };
    const closeList = () => { const l = lists.pop(); out.push(`</li></${l.kind}>`); };
    const flushList = () => { while (lists.length) closeList(); };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`); quote = []; } };
    const flush = () => { flushPara(); flushList(); flushQuote(); };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
      if (fence) {
        flush();
        const body = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
        out.push(`<pre><code${fence[2] ? ` data-lang="${fence[2]}"` : ''}>${body.join('\n')}</code></pre>`);
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) { flush(); const n = Math.min(6, m[1].length + (o.shiftHeadings === false ? 0 : 1)); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
      if ((m = /^\s*&gt;\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      flushQuote();
      // Table: a header row followed by a |---|---| separator.
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
        i--;
        out.push('<div class="md-table"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, j) => `<td>${inline(r[j] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        flushPara();
        const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
        const indent = m[1].length;
        while (lists.length && indent < lists[lists.length - 1].indent) closeList();
        const top = lists[lists.length - 1];
        if (top && indent === top.indent && kind !== top.kind) closeList();
        const cur = lists[lists.length - 1];
        if (cur && indent === cur.indent) out.push('</li>');
        else {
          const n = parseInt(m[2], 10);
          out.push(kind === 'ol' && n > 1 ? `<ol start="${n}">` : `<${kind}>`);
          lists.push({ kind, indent });
        }
        let item = m[3];
        const box = /^\[([ xX])\]\s+(.*)$/.exec(item);
        if (box) item = `<span class="md-box">${box[1].trim() ? '☑' : '☐'}</span> ${box[2]}`;
        out.push(`<li>${inline(item)}`);
        continue;
      }
      if (lists.length && /^\s{2,}\S/.test(line)) { out.push(inline(line.trim())); continue; }
      flushList();
      para.push(line.trim());
    }
    flush();
    return out.join('\n');
  }

  const api = { render, escape: esc, inline };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShipDeckMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
