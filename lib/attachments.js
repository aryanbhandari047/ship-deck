'use strict';
// Bridge chat attachments: screenshots and screen recordings stored under
// <orders dir>/attachments/<uuid>/<safe-name> (dirs 0700, files 0600), one
// attachment per dir. Types are decided by magic bytes, never by the client's
// MIME or file name. Videos also get browser-extracted JPEG stills in frames/
// (frame-0001.jpg ... + index.json) because Claude can read images, not video.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = 'attachments';
const META = '.meta.json';
const FRAMES = 'frames';
const MB = 1024 * 1024;
// Sniffed type -> kind, canonical extension and size limit.
const TYPES = {
  'image/png': { kind: 'image', ext: 'png', max: 20 * MB },
  'image/jpeg': { kind: 'image', ext: 'jpg', max: 20 * MB },
  'image/gif': { kind: 'image', ext: 'gif', max: 20 * MB },
  'image/webp': { kind: 'image', ext: 'webp', max: 20 * MB },
  'video/mp4': { kind: 'video', ext: 'mp4', max: 200 * MB },
  'video/quicktime': { kind: 'video', ext: 'mov', max: 200 * MB },
  'video/webm': { kind: 'video', ext: 'webm', max: 200 * MB },
};
const MAX_UPLOAD = 200 * MB;
const MAX_FRAMES = 40;
const MAX_FRAME = 5 * MB;
const MAX_INDEX = 64 * 1024;
const MAX_PER_MESSAGE = 10;
const SNIFF_BYTES = 64;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FRAME_RE = /^frame-(\d{4})\.jpg$/;
const ACCEPTED = 'png, jpeg, gif, webp images (max 20 MB) or mp4, mov, webm videos (max 200 MB)';

class AttachmentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const root = (ordersDir) => path.join(ordersDir, DIR);
function mkdir0700(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

// The MIME type of a file from its first bytes, or null when it is not an accepted type.
function sniff(buf) {
  const b = Buffer.from(buf || []);
  const ascii = (s, e) => b.subarray(s, e).toString('latin1');
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') return ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (b.length >= 8 && ['moov', 'wide', 'mdat'].includes(ascii(4, 8))) return 'video/quicktime'; // pre-ftyp QuickTime
  // EBML header with DocType "webm" (Matroska .mkv shares the header but is not accepted).
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && ascii(4, SNIFF_BYTES).includes('webm')) return 'video/webm';
  return null;
}

// A file name that is safe as a single path segment, with the sniffed type's extension.
function safeName(name, mime) {
  const t = TYPES[mime];
  const base = String(name || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  let s = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/[.-]+$/, '').slice(0, 80);
  if (!s) s = t ? t.kind : 'file';
  return t ? `${s}.${t.ext}` : s;
}

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

// Absolute dir of one attachment; throws on a bad id or a dir that is not a real directory.
function attachmentDir(ordersDir, id, { mustExist = true } = {}) {
  if (!validId(id)) throw new AttachmentError(400, 'invalid attachment id');
  const dir = path.join(root(ordersDir), id);
  if (!mustExist) return dir;
  let st;
  try { st = fs.lstatSync(dir); } catch { throw new AttachmentError(404, 'no such attachment'); }
  if (!st.isDirectory()) throw new AttachmentError(404, 'no such attachment');
  return dir;
}

// Path of a regular, non-symlink file inside dir; anything else is refused.
function regularFile(dir, name) {
  if (typeof name !== 'string' || !(SAFE_NAME_RE.test(name) || name === META)) throw new AttachmentError(400, 'invalid file name');
  const p = path.join(dir, name);
  if (path.dirname(p) !== dir) throw new AttachmentError(400, 'invalid file name');
  let st;
  try { st = fs.lstatSync(p); } catch { throw new AttachmentError(404, 'no such attachment'); }
  if (!st.isFile()) throw new AttachmentError(404, 'no such attachment');
  return { path: p, size: st.size };
}

// Metadata of one stored attachment, plus its absolute path (and frames, for a video).
function readMeta(ordersDir, id) {
  const dir = attachmentDir(ordersDir, id);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(regularFile(dir, META).path, 'utf8')); } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError(404, 'no such attachment');
  }
  if (!meta || !TYPES[meta.mime] || !SAFE_NAME_RE.test(meta.file || '')) throw new AttachmentError(404, 'no such attachment');
  const f = regularFile(dir, meta.file);
  const out = { id, kind: TYPES[meta.mime].kind, name: String(meta.name || meta.file), mime: meta.mime, path: f.path, size: f.size };
  if (out.kind === 'video') {
    const frames = framesInfo(dir);
    out.frames = frames ? frames.dir : null;
    out.frameCount = frames ? frames.count : 0;
  }
  return out;
}

function framesInfo(dir) {
  const fdir = path.join(dir, FRAMES);
  try {
    if (!fs.lstatSync(fdir).isDirectory()) return null;
    const names = fs.readdirSync(fdir);
    if (!names.includes('index.json')) return null;
    return { dir: fdir, count: names.filter((n) => FRAME_RE.test(n)).length };
  } catch { return null; }
}

function writeFile0600(p, data) {
  fs.writeFileSync(p, data, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

// Stores a new attachment from a readable stream (an upload). Sniffs the first
// bytes, enforces the per-type limit as bytes arrive, and returns readMeta().
function storeStream(ordersDir, stream, { name, declaredSize } = {}) {
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD) {
    return Promise.reject(new AttachmentError(413, `file is larger than ${MAX_UPLOAD / MB} MB`));
  }
  const id = crypto.randomUUID();
  const dir = mkdir0700(path.join(mkdir0700(root(ordersDir)), id));
  const part = path.join(dir, '.part');
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(part, 'w', 0o600);
    let head = Buffer.alloc(0);
    let mime = null;
    let size = 0;
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err;
      try { fs.closeSync(fd); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
      stream.resume(); // drain the rest so the client still gets the response
      reject(err);
    };
    const check = () => {
      if (!mime) return;
      const t = TYPES[mime];
      if (size > t.max) fail(new AttachmentError(413, `${t.kind} is larger than ${t.max / MB} MB`));
    };
    stream.on('data', (chunk) => {
      if (failed) return;
      try { onData(chunk); } catch (e) { fail(e); }
    });
    const onData = (chunk) => {
      size += chunk.length;
      if (!mime) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= SNIFF_BYTES) {
          mime = sniff(head);
          if (!mime) return fail(new AttachmentError(415, `unsupported file type: send ${ACCEPTED}`));
          fs.writeSync(fd, head);
          head = null;
        }
      } else fs.writeSync(fd, chunk);
      check();
    };
    let ended = false;
    stream.on('error', (e) => fail(e));
    stream.on('close', () => { if (!ended) fail(new AttachmentError(400, 'upload aborted')); });
    stream.on('end', () => {
      ended = true;
      if (failed) return;
      try { onEnd(); } catch (e) { fail(e); }
    });
    const onEnd = () => {
      if (!mime) {
        mime = sniff(head);
        if (!mime) return fail(new AttachmentError(415, size ? `unsupported file type: send ${ACCEPTED}` : 'empty file'));
        fs.writeSync(fd, head);
        check();
        if (failed) return;
      }
      fs.closeSync(fd);
      const file = safeName(name, mime);
      fs.renameSync(part, path.join(dir, file));
      fs.chmodSync(path.join(dir, file), 0o600);
      writeFile0600(path.join(dir, META), JSON.stringify({ id, file, name: String(name || file).slice(0, 200), mime, size, ts: new Date().toISOString() }));
      resolve(readMeta(ordersDir, id));
    };
  });
}

// Type and size of a local file, with the same checks as uploads; throws when it is not accepted.
function checkFile(src) {
  let st;
  try { st = fs.statSync(src); } catch { throw new AttachmentError(404, `no such file: ${src}`); }
  if (!st.isFile()) throw new AttachmentError(400, `not a regular file: ${src}`);
  const head = Buffer.alloc(SNIFF_BYTES);
  const fd = fs.openSync(src, 'r');
  let n;
  try { n = fs.readSync(fd, head, 0, SNIFF_BYTES, 0); } finally { fs.closeSync(fd); }
  const mime = sniff(head.subarray(0, n));
  if (!mime) throw new AttachmentError(415, `${path.basename(src)}: unsupported file type: send ${ACCEPTED}`);
  const t = TYPES[mime];
  if (st.size > t.max) throw new AttachmentError(413, `${path.basename(src)}: ${t.kind} is larger than ${t.max / MB} MB`);
  return { mime, size: st.size };
}

// Copies a local file in as a new attachment (first mate replies).
function importFile(ordersDir, src) {
  const { mime, size } = checkFile(src);
  const id = crypto.randomUUID();
  const dir = mkdir0700(path.join(mkdir0700(root(ordersDir)), id));
  const file = safeName(path.basename(src), mime);
  fs.copyFileSync(src, path.join(dir, file));
  fs.chmodSync(path.join(dir, file), 0o600);
  writeFile0600(path.join(dir, META), JSON.stringify({ id, file, name: path.basename(src).slice(0, 200), mime, size, ts: new Date().toISOString() }));
  return readMeta(ordersDir, id);
}

// Stores one browser-extracted still (frame-0001.jpg...) or frames/index.json for a video attachment.
async function storeFrame(ordersDir, id, name, stream) {
  const meta = readMeta(ordersDir, id);
  if (meta.kind !== 'video') throw new AttachmentError(400, 'frames belong to a video attachment');
  const m = FRAME_RE.exec(String(name || ''));
  if (!m && name !== 'index.json') throw new AttachmentError(400, 'frame name must be frame-NNNN.jpg or index.json');
  if (m && (Number(m[1]) < 1 || Number(m[1]) > MAX_FRAMES)) throw new AttachmentError(400, `at most ${MAX_FRAMES} frames`);
  const max = m ? MAX_FRAME : MAX_INDEX;
  const buf = await readCapped(stream, max);
  let data = buf;
  if (m) {
    if (sniff(buf) !== 'image/jpeg') throw new AttachmentError(415, 'frames must be JPEG');
  } else {
    let idx;
    try { idx = JSON.parse(buf.toString('utf8')); } catch { throw new AttachmentError(400, 'index.json is not JSON'); }
    const frames = Array.isArray(idx && idx.frames) ? idx.frames : null;
    if (!frames || frames.length > MAX_FRAMES) throw new AttachmentError(400, 'index.json needs a frames array');
    // Rewritten from known fields only.
    data = JSON.stringify({
      video: meta.path,
      duration: Number.isFinite(idx.duration) ? idx.duration : null,
      width: Number.isFinite(idx.width) ? idx.width : null,
      height: Number.isFinite(idx.height) ? idx.height : null,
      frames: frames.filter((f) => f && FRAME_RE.test(f.file) && Number.isFinite(f.t)).map((f) => ({ file: f.file, t: Math.round(f.t * 1000) / 1000 })),
    }, null, 2);
  }
  const fdir = mkdir0700(path.join(path.dirname(meta.path), FRAMES));
  if (fs.lstatSync(fdir).isSymbolicLink()) throw new AttachmentError(400, 'invalid frames dir');
  writeFile0600(path.join(fdir, name), data);
  return { id, name, size: Buffer.byteLength(data) };
}

function readCapped(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    stream.on('data', (c) => {
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    stream.on('end', () => (over ? reject(new AttachmentError(413, `larger than ${Math.round(max / 1024)} KB`)) : resolve(Buffer.concat(chunks))));
    stream.on('error', reject);
  });
}

// Validates the attachment ids on an order or reply and returns their records
// {id, kind, name, path, size, mime[, frames, frameCount]}.
function resolveIds(ordersDir, ids) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new AttachmentError(400, 'attachments must be a list of ids');
  if (ids.length > MAX_PER_MESSAGE) throw new AttachmentError(400, `at most ${MAX_PER_MESSAGE} attachments per message`);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(readMeta(ordersDir, id));
  }
  return out;
}

// One HTTP Range header against a file size: null = serve it all, {start, end}
// (inclusive) = 206, 'unsatisfiable' = 416. Multi-range requests get the whole file.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return String(header).includes(',') ? null : 'unsatisfiable';
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

// Streams an attachment to an HTTP response with Range support.
function serve(ordersDir, id, req, res) {
  const meta = readMeta(ordersDir, id);
  const range = parseRange(req.headers.range, meta.size);
  const headers = {
    'Content-Type': meta.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `inline; filename="${path.basename(meta.path)}"`,
  };
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${meta.size}` });
    return res.end();
  }
  const { start, end } = range || { start: 0, end: meta.size - 1 };
  const len = meta.size ? end - start + 1 : 0;
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': len, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${meta.size}` } : {}) });
  if (req.method === 'HEAD' || !len) return res.end();
  fs.createReadStream(meta.path, { start, end }).on('error', () => res.destroy()).pipe(res);
}

// "1.2 MB" style sizes for the CLI.
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

module.exports = {
  DIR,
  TYPES,
  MAX_UPLOAD,
  MAX_FRAMES,
  MAX_FRAME,
  MAX_PER_MESSAGE,
  ACCEPTED,
  AttachmentError,
  root,
  sniff,
  safeName,
  validId,
  readMeta,
  storeStream,
  checkFile,
  importFile,
  storeFrame,
  resolveIds,
  parseRange,
  serve,
  humanSize,
};
