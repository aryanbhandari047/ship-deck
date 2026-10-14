'use strict';
// Storage behind a tiny Redis-shaped adapter: cmd(['GET', k]) and pipeline([[...], ...]).
// Production uses Upstash Redis over its REST API; local development and tests use the in-memory
// store, which implements the same few commands (and counts them, for the cost tests).

class StoreError extends Error {
  constructor(message, { quota = false } = {}) { super(message); this.quota = quota; }
}
// Upstash answers free-plan overuse with errors like "ERR max requests limit exceeded".
const QUOTA_RE = /limit|quota|exceeded|too many/i;

function createUpstashStore({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  if (!url || !token) throw new StoreError('Upstash is not configured (UPSTASH_REDIS_REST_URL / _TOKEN)');
  const base = url.replace(/\/+$/, '');
  async function post(p, body) {
    let res;
    try {
      res = await fetchImpl(base + p, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StoreError('store unreachable');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      const msg = (data && data.error) || `store error ${res.status}`;
      throw new StoreError(msg, { quota: res.status === 429 || QUOTA_RE.test(msg) });
    }
    return data;
  }
  const unwrap = (r) => {
    if (r && r.error) throw new StoreError(r.error, { quota: QUOTA_RE.test(r.error) });
    return r ? r.result : null;
  };
  return {
    kind: 'upstash',
    cmd: async (args) => unwrap(await post('', args.map(String))),
    pipeline: async (list) => (list.length ? (await post('/pipeline', list.map((a) => a.map(String)))).map(unwrap) : []),
  };
}

// In-memory store with TTLs on an injectable clock. Only the commands the relay uses.
function createMemoryStore({ now = Date.now } = {}) {
  const data = new Map(); // key -> { type, v, exp }
  const stats = { commands: 0 };
  const live = (k) => {
    const e = data.get(k);
    if (e && e.exp && e.exp <= now()) { data.delete(k); return null; }
    return e || null;
  };
  const of = (k, type, make) => {
    let e = live(k);
    if (e && e.type !== type) throw new StoreError('WRONGTYPE');
    if (!e && make) { e = { type, v: make(), exp: 0 }; data.set(k, e); }
    return e;
  };
  const str = (k) => { const e = of(k, 'string'); return e ? e.v : null; };
  const score = (s) => (s === '-inf' ? -Infinity : s === '+inf' ? Infinity : Number(s));

  function run(args) {
    stats.commands++;
    const [name, ...a] = args.map(String);
    const k = a[0];
    switch (name.toUpperCase()) {
      case 'GET': return str(k);
      case 'MGET': return a.map(str);
      case 'SET': {
        const opt = a.slice(2).map((x) => x.toUpperCase());
        if (opt.includes('NX') && live(k)) return null;
        const exIdx = opt.indexOf('EX');
        data.set(k, { type: 'string', v: a[1], exp: exIdx >= 0 ? now() + Number(a[2 + exIdx + 1]) * 1000 : 0 });
        return 'OK';
      }
      case 'GETDEL': { const v = str(k); data.delete(k); return v; }
      case 'DEL': { let n = 0; for (const x of a) if (live(x)) { data.delete(x); n++; } return n; }
      case 'INCR': { const e = of(k, 'string', () => '0'); e.v = String(Number(e.v) + 1); return Number(e.v); }
      case 'EXPIRE': { const e = live(k); if (!e) return 0; e.exp = now() + Number(a[1]) * 1000; return 1; }
      case 'TTL': { const e = live(k); return !e ? -2 : e.exp ? Math.ceil((e.exp - now()) / 1000) : -1; }
      case 'SADD': { const e = of(k, 'set', () => new Set()); let n = 0; for (const m of a.slice(1)) if (!e.v.has(m)) { e.v.add(m); n++; } return n; }
      case 'SREM': { const e = of(k, 'set'); if (!e) return 0; let n = 0; for (const m of a.slice(1)) if (e.v.delete(m)) n++; return n; }
      case 'SMEMBERS': { const e = of(k, 'set'); return e ? [...e.v] : []; }
      case 'ZADD': { const e = of(k, 'zset', () => new Map()); const had = e.v.has(a[2]); e.v.set(a[2], Number(a[1])); return had ? 0 : 1; }
      case 'ZREMRANGEBYSCORE': {
        const e = of(k, 'zset'); if (!e) return 0;
        const lo = score(a[1]); const hi = score(a[2]); let n = 0;
        for (const [m, s] of e.v) if (s >= lo && s <= hi) { e.v.delete(m); n++; }
        return n;
      }
      case 'ZREVRANGEBYSCORE': {
        const e = of(k, 'zset'); if (!e) return [];
        const hi = score(a[1]); const lo = score(a[2]);
        let rows = [...e.v].filter(([, s]) => s >= lo && s <= hi).sort((x, y) => y[1] - x[1]).map(([m]) => m);
        const li = a.findIndex((x) => x.toUpperCase() === 'LIMIT');
        if (li >= 0) rows = rows.slice(Number(a[li + 1]), Number(a[li + 1]) + Number(a[li + 2]));
        return rows;
      }
      case 'SCAN': { // one pass: MATCH with a trailing * only, COUNT ignored
        const mi = a.findIndex((x) => x.toUpperCase() === 'MATCH');
        const pre = mi >= 0 ? a[mi + 1].replace(/\*$/, '') : '';
        return ['0', [...data.keys()].filter((x) => x.startsWith(pre) && live(x))];
      }
      default: throw new StoreError('unsupported command ' + name);
    }
  }
  return {
    kind: 'memory',
    stats,
    cmd: async (args) => run(args),
    pipeline: async (list) => list.map(run),
    // For tests only: the raw value, without counting.
    peek: (k) => { const e = live(k); return e ? e.v : null; },
  };
}

module.exports = { StoreError, createUpstashStore, createMemoryStore };
