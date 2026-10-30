'use strict';
// Ask a teammate's context: a teammate's agent asks a question and gets up to 3 short passages,
// with citations, from what a captain granted with the `ask` scope. The relay only ranks text
// (BM25, no model, no outside service); the receiver's own agent writes the answer. Pure
// functions; lib/app.js checks grants, rate-limits, audits and routes.
//   lib:<sub> field "x"   per-item term summary, built when the library is pushed (summarize)
//   askh:<capSub>:<viewerSub>:<hour> / askd:...:<day>  per-grant question counters
const STOP = new Set(('the and for are but not you all any can had her was one our out has his how its may new now old see two who did get let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many over such take than them well were what into more only also back after then them there these where which while about their would could should other being does each every them those your yours how why'
).split(' '));
const PER_HOUR = 30;
const PER_DAY = 200;
const PASSAGES = 3;
const PASSAGE_CHARS = 600;
const TOP_ITEMS = 3; // items read in full per question
const TERMS_PER_ITEM = 64;
const MAX_QUESTION = 500;

function tokens(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,29}/g) || []).filter((t) => t.length >= 3 && !STOP.has(t));
}
function counts(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// Per item, its length in tokens and its most frequent terms (title and description count
// three times). Stored as field "x" next to the library, about a fifth of its size.
function summarize(items) {
  const out = {};
  for (const it of items) {
    const all = [...tokens(it.text), ...[].concat(...Array(3).fill(tokens(`${it.title} ${it.description}`)))];
    const top = [...counts(all)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TERMS_PER_ITEM);
    out[it.key] = { n: all.length, t: Object.fromEntries(top) };
  }
  return out;
}

// BM25 over documents given as { id, n, tf: Map|object }; -> [{ id, score }] best first, score > 0.
function bm25(query, docs, k1 = 1.2, b = 0.75) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const avg = docs.reduce((s, d) => s + d.n, 0) / docs.length || 1;
  const tf = (d, t) => (d.tf instanceof Map ? d.tf.get(t) : d.tf[t]) || 0;
  const df = Object.fromEntries(q.map((t) => [t, docs.filter((d) => tf(d, t) > 0).length]));
  return docs.map((d) => {
    let score = 0;
    for (const t of q) {
      const f = tf(d, t);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.n) / avg)));
    }
    return { id: d.id, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}

// An item's text as passages of whole lines, each at most PASSAGE_CHARS: [{ from, to, text }].
function passages(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    const l = line.slice(0, PASSAGE_CHARS);
    if (cur && cur.text.length + 1 + l.length > PASSAGE_CHARS) { out.push(cur); cur = null; }
    if (!cur) cur = { from: i + 1, to: i + 1, text: l };
    else { cur.text += '\n' + l; cur.to = i + 1; }
  });
  if (cur && cur.text.trim()) out.push(cur);
  return out.filter((p) => p.text.trim());
}

// A question body -> { question, captain } (or throws).
function sanitizeQuestion(body) {
  if (!body || typeof body !== 'object' || typeof body.question !== 'string') throw new Error('ask needs a question');
  const question = body.question.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
  if (!tokens(question).length) throw new Error('ask a question with a few real words in it');
  const captain = typeof body.captain === 'string' ? body.captain.trim().toLowerCase().slice(0, 254) : '';
  return { question, captain };
}

module.exports = { PER_HOUR, PER_DAY, PASSAGES, PASSAGE_CHARS, TOP_ITEMS, MAX_QUESTION, tokens, summarize, bm25, passages, sanitizeQuestion };
