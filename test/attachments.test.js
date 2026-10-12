'use strict';
// Bridge attachments: magic-byte validation, safe names and path safety, size
// limits, upload guards, Range serving, video stills, chat orders carrying
// attachments, reply --attach and the CLI listing. Fabricated bytes and temp dirs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const att = require('../lib/attachments');
const orders = require('../lib/orders');
const cli = require('../bin/orders');
const { createServer } = require('../server');

const FIX = path.join(__dirname, 'fixtures');
const mode = (p) => fs.statSync(p).mode & 0o777;
const pad = (head, n = 200) => Buffer.concat([Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1'), Buffer.alloc(Math.max(0, n - head.length), 7)]);

// Minimal fabricated headers for every accepted type, plus look-alikes that must be refused.
const SAMPLES = {
  png: pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  gif: pad('GIF89a'),
  webp: pad('RIFF\x10\x00\x00\x00WEBPVP8 '),
  mp4: pad('\x00\x00\x00\x18ftypisom'),
  mov: pad('\x00\x00\x00\x14ftypqt  '),
  webm: pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm')])),
};
const BAD = {
  pdf: pad('%PDF-1.7\n'),
  exe: pad('MZ\x90\x00'),
  html: pad('<!doctype html><script>alert(1)</script>'),
  mkv: pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), Buffer.from('matroska')])),
  svg: pad('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  tiny: Buffer.from([0x89, 0x50]),
};

function tempDir(t, prefix = 'ship-deck-att-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(dir, ...argv) {
  const out = [];
  const err = [];
  const code = cli.main(argv, dir, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function startServer(t) {
  const home = tempDir(t, 'ship-deck-home-');
  fs.cpSync(path.join(FIX, 'home'), home, { recursive: true });
  const ordersDir = tempDir(t);
  const claudeDir = tempDir(t, 'ship-deck-claude-');
  const exec = async () => { throw new Error('no commands in attachment tests'); };
  const server = createServer({ home, tmux: false, staleDays: 7, ordersDir, memoryDir: null, claudeDir, exec });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const upload = (query, body, headers = {}) => fetch(`${base}/api/attachments?${query}`, {
    method: 'POST', headers: { 'X-Ship-Deck': '1', 'Content-Type': 'application/octet-stream', ...headers }, body,
  });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ship-Deck': '1' }, body: JSON.stringify(body) });
  return { home, ordersDir, port, base, upload, post };
}

// ---------- magic bytes and names ----------

test('sniff accepts only png/jpeg/gif/webp/mp4/mov/webm by their magic bytes', () => {
  const want = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  for (const [k, mime] of Object.entries(want)) assert.equal(att.sniff(SAMPLES[k]), mime, k);
  for (const [k, buf] of Object.entries(BAD)) assert.equal(att.sniff(buf), null, k);
  assert.equal(att.sniff(Buffer.alloc(0)), null);
});

test('safeName keeps one path segment and forces the sniffed extension', () => {
  assert.equal(att.safeName('../../etc/passwd', 'image/png'), 'passwd.png');
  assert.equal(att.safeName('..\\..\\Windows\\evil.exe', 'image/jpeg'), 'evil.jpg');
  assert.equal(att.safeName('Screen Shot 2026-10-12 at 9.41.png', 'image/png'), 'Screen-Shot-2026-10-12-at-9.41.png');
  assert.equal(att.safeName('.htaccess', 'image/gif'), 'image.gif');
  assert.equal(att.safeName('', 'video/webm'), 'video.webm');
  assert.equal(att.safeName('clip.png', 'video/quicktime'), 'clip.mov', 'type comes from the bytes, not the name');
  assert.ok(att.safeName('x'.repeat(500), 'image/png').length <= 84);
});

test('parseRange handles start-end, open, suffix, clamping and unsatisfiable ranges', () => {
  assert.equal(att.parseRange(undefined, 100), null);
  assert.deepEqual(att.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(att.parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(att.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(att.parseRange('bytes=50-5000', 100), { start: 50, end: 99 });
  assert.deepEqual(att.parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(att.parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(att.parseRange('bytes=9-2', 100), 'unsatisfiable');
  assert.equal(att.parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(att.parseRange('items=0-1', 100), 'unsatisfiable');
  assert.equal(att.parseRange('bytes=0-1,5-6', 100), null, 'multi-range gets the whole file');
});

// ---------- storage, limits and path safety ----------

test('storeStream writes <dir>/attachments/<uuid>/<safe-name> with 0700 dirs and 0600 files', async (t) => {
  const dir = tempDir(t);
  const a = await att.storeStream(dir, Readable.from([SAMPLES.png.subarray(0, 5), SAMPLES.png.subarray(5)]), { name: '../../shot.png' });
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(a.kind, 'image');
  assert.equal(a.mime, 'image/png');
  assert.equal(a.size, SAMPLES.png.length);
  assert.equal(a.path, path.join(dir, 'attachments', a.id, 'shot.png'));
  assert.deepEqual(fs.readFileSync(a.path), SAMPLES.png);
  assert.equal(mode(path.join(dir, 'attachments')), 0o700);
  assert.equal(mode(path.dirname(a.path)), 0o700);
  assert.equal(mode(a.path), 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(a.path)).sort(), ['.meta.json', 'shot.png']);
  assert.equal(mode(path.join(path.dirname(a.path), '.meta.json')), 0o600);

  const tiny = await att.storeStream(dir, Readable.from([SAMPLES.jpeg.subarray(0, 10)]), { name: 'tiny.jpg' });
  assert.equal(tiny.size, 10, 'files shorter than the sniff window still store');
});

test('unsupported types and oversize files are refused and leave nothing behind', async (t) => {
  const dir = tempDir(t);
  for (const [k, buf] of Object.entries(BAD)) {
    await assert.rejects(att.storeStream(dir, Readable.from([buf]), { name: `x.png` }), (e) => e.status === 415 && /unsupported|empty/.test(e.message), k);
  }
  await assert.rejects(att.storeStream(dir, Readable.from([]), { name: 'empty.png' }), /empty file/);

  // An image one byte over 20 MB, streamed in chunks: refused while it arrives.
  const MB = 1024 * 1024;
  async function* big(head, total) {
    yield head;
    let sent = head.length;
    const chunk = Buffer.alloc(MB);
    while (sent < total) { const n = Math.min(MB, total - sent); sent += n; yield chunk.subarray(0, n); }
  }
  await assert.rejects(att.storeStream(dir, Readable.from(big(SAMPLES.png, 20 * MB + 1)), { name: 'big.png' }), (e) => e.status === 413 && /image is larger than 20 MB/.test(e.message));
  const ok = await att.storeStream(dir, Readable.from(big(SAMPLES.png, 20 * MB)), { name: 'max.png' });
  assert.equal(ok.size, 20 * MB, 'exactly 20 MB is allowed');
  // Videos: up to 200 MB; a declared size over it is refused before reading.
  await assert.rejects(att.storeStream(dir, Readable.from([SAMPLES.webm]), { name: 'v.webm', declaredSize: 200 * MB + 1 }), (e) => e.status === 413);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'attachments')), [ok.id], 'refused uploads are removed');

  // importFile applies the same per-type limit to local files (sparse file, no 200 MB write).
  const src = path.join(dir, 'huge.mp4');
  fs.writeFileSync(src, SAMPLES.mp4);
  fs.truncateSync(src, 200 * MB + 1);
  assert.throws(() => att.checkFile(src), (e) => e.status === 413 && /video is larger than 200 MB/.test(e.message));
  fs.truncateSync(src, 200 * MB);
  assert.equal(att.checkFile(src).mime, 'video/mp4');
});

test('ids, frame names and stored metadata cannot escape the attachments dir', async (t) => {
  const dir = tempDir(t);
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'top secret');
  for (const id of ['..', '../secret.txt', '../../etc/passwd', 'abc', '', null, '00000000-0000-0000-0000-00000000000g', '/etc/passwd']) {
    assert.throws(() => att.readMeta(dir, id), (e) => e.status === 400, String(id));
  }
  assert.throws(() => att.readMeta(dir, '00000000-0000-0000-0000-000000000000'), (e) => e.status === 404);

  const v = await att.storeStream(dir, Readable.from([SAMPLES.webm]), { name: 'clip.webm' });
  for (const name of ['../x.jpg', 'frames/../../x.jpg', 'frame-1.jpg', 'frame-0001.png', 'index.json/..', '.meta.json']) {
    await assert.rejects(att.storeFrame(dir, v.id, name, Readable.from([SAMPLES.jpeg])), (e) => e.status === 400, name);
  }
  await assert.rejects(att.storeFrame(dir, '../..', 'frame-0001.jpg', Readable.from([SAMPLES.jpeg])), (e) => e.status === 400);

  // A tampered meta pointing outside, or a stored file swapped for a symlink, is refused.
  const metaPath = path.join(dir, 'attachments', v.id, '.meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, file: '../../secret.txt' }));
  assert.throws(() => att.readMeta(dir, v.id), (e) => e.status === 404);
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  fs.rmSync(v.path);
  fs.symlinkSync(secret, v.path);
  assert.throws(() => att.readMeta(dir, v.id), (e) => e.status === 404);
  // A symlinked attachment dir is refused too.
  const link = '11111111-1111-4111-8111-111111111111';
  fs.symlinkSync(path.dirname(v.path), path.join(dir, 'attachments', link));
  assert.throws(() => att.readMeta(dir, link), (e) => e.status === 404);
});

// ---------- HTTP ----------

test('POST /api/attachments: guards, magic bytes, and GET with Range support', async (t) => {
  const { ordersDir, port, base, upload } = await startServer(t);

  assert.equal((await fetch(base + '/api/attachments?name=a.png', { method: 'POST', body: SAMPLES.png })).status, 403, 'no X-Ship-Deck');
  assert.equal((await upload('name=a.png', SAMPLES.png, { 'Content-Type': 'multipart/form-data; boundary=x' })).status, 403, 'form upload');
  assert.equal((await upload('name=a.png', SAMPLES.png, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal((await upload('name=a.png', SAMPLES.png, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload('name=a.png', SAMPLES.png, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/attachments?name=a.png', method: 'POST', headers: { Host: 'evil.example', 'X-Ship-Deck': '1' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(SAMPLES.png);
  });
  assert.equal(badHost, 421);
  assert.ok(!fs.existsSync(path.join(ordersDir, 'attachments')), 'nothing stored by refused requests');

  // A text file claiming to be a PNG is refused on its bytes.
  let res = await upload('name=fake.png', BAD.html, { 'Content-Type': 'image/png' });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /unsupported file type/);

  res = await upload('name=' + encodeURIComponent('../../Screen Shot.png'), SAMPLES.png, { 'Content-Type': 'image/png' });
  assert.equal(res.status, 200);
  const { attachment: a } = await res.json();
  assert.deepEqual(Object.keys(a).sort(), ['id', 'kind', 'mime', 'name', 'size']);
  assert.equal(a.kind, 'image');
  assert.ok(fs.existsSync(path.join(ordersDir, 'attachments', a.id, 'Screen-Shot.png')));

  res = await fetch(`${base}/api/attachments/${a.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), SAMPLES.png);

  res = await fetch(`${base}/api/attachments/${a.id}`, { headers: { Range: 'bytes=8-15' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 8-15/${SAMPLES.png.length}`);
  assert.equal(res.headers.get('content-length'), '8');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), SAMPLES.png.subarray(8, 16));

  res = await fetch(`${base}/api/attachments/${a.id}`, { headers: { Range: 'bytes=-4' } });
  assert.equal(res.status, 206);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), SAMPLES.png.subarray(-4));

  res = await fetch(`${base}/api/attachments/${a.id}`, { headers: { Range: 'bytes=9999-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SAMPLES.png.length}`);

  for (const p of ['..%2F..%2Fetc%2Fpasswd', '..%5C..%5Cwin.ini', 'not-an-id', encodeURIComponent(path.join(ordersDir, 'orders.jsonl'))]) {
    assert.equal((await fetch(`${base}/api/attachments/${p}`)).status, 400, p);
  }
  assert.equal((await fetch(`${base}/api/attachments/00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/${a.id}/../../orders.jsonl`)).status, 404, 'only the one-segment route exists');
});

test('a video gets stills and index.json, and a chat order records paths and the frames dir', async (t) => {
  const { ordersDir, upload, post, base } = await startServer(t);
  const img = (await (await upload('name=shot.png', SAMPLES.png)).json()).attachment;
  const vid = (await (await upload('name=recording.webm', SAMPLES.webm, { 'Content-Type': 'video/webm' })).json()).attachment;
  assert.equal(vid.kind, 'video');

  assert.equal((await upload(`parent=${img.id}&name=frame-0001.jpg`, SAMPLES.jpeg)).status, 400, 'frames only on videos');
  assert.equal((await upload(`parent=${vid.id}&name=frame-0001.jpg`, SAMPLES.png)).status, 415, 'frames must be JPEG');
  assert.equal((await upload(`parent=${vid.id}&name=frame-0041.jpg`, SAMPLES.jpeg)).status, 400, 'at most 40');
  assert.equal((await upload(`parent=${vid.id}&name=..%2F..%2Fevil.jpg`, SAMPLES.jpeg)).status, 400);
  for (const n of [1, 2]) assert.equal((await upload(`parent=${vid.id}&name=frame-000${n}.jpg`, SAMPLES.jpeg, { 'Content-Type': 'image/jpeg' })).status, 200);
  assert.equal((await upload(`parent=${vid.id}&name=index.json`, 'not json', { 'Content-Type': 'application/json' })).status, 400);
  const index = { duration: 3.2, width: 1280, height: 720, frames: [{ file: 'frame-0001.jpg', t: 0 }, { file: 'frame-0002.jpg', t: 2 }, { file: '../x', t: 1 }], extra: 'dropped' };
  assert.equal((await upload(`parent=${vid.id}&name=index.json`, JSON.stringify(index), { 'Content-Type': 'application/json' })).status, 200);

  const framesDir = path.join(ordersDir, 'attachments', vid.id, 'frames');
  assert.deepEqual(fs.readdirSync(framesDir).sort(), ['frame-0001.jpg', 'frame-0002.jpg', 'index.json']);
  assert.equal(mode(framesDir), 0o700);
  assert.equal(mode(path.join(framesDir, 'frame-0001.jpg')), 0o600);
  const stored = JSON.parse(fs.readFileSync(path.join(framesDir, 'index.json'), 'utf8'));
  assert.deepEqual(stored.frames, [{ file: 'frame-0001.jpg', t: 0 }, { file: 'frame-0002.jpg', t: 2 }]);
  assert.equal(stored.video, path.join(ordersDir, 'attachments', vid.id, 'recording.webm'));
  assert.equal(stored.extra, undefined);

  // Unknown ids, bad ids and attachments on other kinds are refused.
  assert.equal((await post('/api/orders', { kind: 'chat', text: 'x', attachments: ['00000000-0000-4000-8000-000000000000'] })).status, 400);
  assert.equal((await post('/api/orders', { kind: 'chat', text: 'x', attachments: ['../../etc'] })).status, 400);
  assert.equal((await post('/api/orders', { kind: 'chat', text: 'x', attachments: 'nope' })).status, 400);
  assert.equal((await post('/api/orders', { kind: 'chat', text: 'x', attachments: Array(11).fill(img.id) })).status, 400);
  assert.equal((await post('/api/orders', { kind: 'status', target: 'alpha-fix', attachments: [img.id] })).status, 400);

  const res = await post('/api/orders', { kind: 'chat', text: 'The deck flickers, see the recording', attachments: [img.id, vid.id] });
  assert.equal(res.status, 200);
  const { order } = await res.json();
  assert.deepEqual(order.attachments, [
    { id: img.id, kind: 'image', name: 'shot.png', path: path.join(ordersDir, 'attachments', img.id, 'shot.png'), size: SAMPLES.png.length, mime: 'image/png' },
    { id: vid.id, kind: 'video', name: 'recording.webm', path: path.join(ordersDir, 'attachments', vid.id, 'recording.webm'), size: SAMPLES.webm.length, mime: 'video/webm', frames: framesDir, frameCount: 2 },
  ]);
  // Attachments-only messages are allowed.
  const only = await (await post('/api/orders', { kind: 'chat', text: '', attachments: [img.id] })).json();
  assert.equal(only.ok, true);
  assert.equal(only.order.text, '');
  assert.equal((await post('/api/orders', { kind: 'chat', text: '', attachments: [] })).status, 400);

  const thread = await (await fetch(base + '/api/thread')).json();
  const item = thread.items.find((x) => x.id === order.id);
  assert.equal(item.attachments.length, 2);
  assert.equal(item.attachments[1].frames, framesDir);

  // list --pending prints each path and the video's frames dir under the message.
  const r = run(ordersDir, 'list', '--pending');
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  const at = lines.findIndex((l) => l.startsWith(order.id));
  assert.deepEqual(lines.slice(at + 1, at + 5), [
    '    The deck flickers, see the recording',
    `    attachment: image shot.png (${att.humanSize(SAMPLES.png.length)}) ${path.join(ordersDir, 'attachments', img.id, 'shot.png')}`,
    `    attachment: video recording.webm (${att.humanSize(SAMPLES.webm.length)}) ${path.join(ordersDir, 'attachments', vid.id, 'recording.webm')}`,
    `      frames: ${framesDir} (2 stills, index.json has timestamps)`,
  ]);
  const json = JSON.parse(run(ordersDir, 'list', '--pending', '--json').out);
  assert.equal(json.find((o) => o.id === order.id).attachments[0].path, path.join(ordersDir, 'attachments', img.id, 'shot.png'));
});

// ---------- first mate replies ----------

test('reply --attach copies files into the attachments dir and the thread renders them', async (t) => {
  const dir = tempDir(t);
  const src = tempDir(t, 'ship-deck-src-');
  fs.writeFileSync(path.join(src, 'after fix.png'), SAMPLES.png);
  fs.writeFileSync(path.join(src, 'demo.mov'), SAMPLES.mov);
  fs.writeFileSync(path.join(src, 'notes.pdf'), BAD.pdf);
  const chat = orders.createOrder(dir, { kind: 'chat', text: 'Show me the fix' });

  // A refused file fails the whole reply before anything is written.
  let r = run(dir, 'reply', chat.id, '--attach', path.join(src, 'after fix.png'), '--attach', path.join(src, 'notes.pdf'), 'Here');
  assert.equal(r.code, 1);
  assert.match(r.err, /notes\.pdf: unsupported file type/);
  r = run(dir, 'reply', chat.id, '--attach', path.join(src, 'missing.png'), 'Here');
  assert.equal(r.code, 1);
  assert.match(r.err, /no such file/);
  assert.ok(!fs.existsSync(path.join(dir, orders.REPLIES_FILE)));
  assert.ok(!fs.existsSync(path.join(dir, 'attachments')));

  r = run(dir, 'reply', chat.id, '--ack', 'done', '--attach', path.join(src, 'after fix.png'), '--attach', path.join(src, 'demo.mov'), 'Fixed,', 'see', 'both');
  assert.equal(r.code, 0, r.err);
  const reply = orders.readReplies(dir)[0];
  assert.equal(reply.text, 'Fixed, see both');
  assert.equal(reply.attachments.length, 2);
  const [png, mov] = reply.attachments;
  assert.equal(png.kind, 'image');
  assert.equal(png.name, 'after fix.png');
  assert.equal(png.path, path.join(dir, 'attachments', png.id, 'after-fix.png'));
  assert.deepEqual(fs.readFileSync(png.path), SAMPLES.png);
  assert.equal(mode(png.path), 0o600);
  assert.equal(mode(path.dirname(png.path)), 0o700);
  assert.equal(mov.kind, 'video');
  assert.equal(mov.mime, 'video/quicktime');
  assert.equal(mov.frames, null);
  assert.ok(fs.existsSync(path.join(src, 'demo.mov')), 'the source is copied, not moved');
  assert.match(r.out, /^r-\S+ reply to o-\S+ \(done\)\n {4}attachment: image after fix\.png \(\d+ B\) \/.*after-fix\.png\n {4}attachment: video demo\.mov/);
  assert.equal(orders.listOrders(dir)[0].status, 'done');

  // Attachments-only unprompted reply; the thread CLI shows the path.
  r = run(dir, 'reply', '-', '--attach', path.join(src, 'after fix.png'));
  assert.equal(r.code, 0, r.err);
  const th = run(dir, 'thread');
  assert.match(th.out, /first mate {2}r-\S+\n {4}attachment: image after fix\.png/);
  const items = orders.buildThread(dir);
  assert.equal(items[items.length - 1].attachments[0].kind, 'image');

  // The server streams reply attachments like any other.
  const home = tempDir(t, 'ship-deck-home-');
  fs.cpSync(path.join(FIX, 'home'), home, { recursive: true });
  const server = createServer({ home, tmux: false, ordersDir: dir, memoryDir: null, claudeDir: tempDir(t, 'ship-deck-claude-'), exec: async () => ({ code: 1 }) });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/attachments/${mov.id}`, { headers: { Range: 'bytes=4-11' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/quicktime');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('latin1'), 'ftypqt  ');
});

test('malformed attachment records in the logs are dropped, not rendered', (t) => {
  const dir = tempDir(t);
  const good = { id: '22222222-2222-4222-8222-222222222222', kind: 'image', name: 'a.png', path: '/x/a.png', size: 1 };
  fs.writeFileSync(path.join(dir, orders.REPLIES_FILE), JSON.stringify({ id: 'r-20261012T160000000Z-0001', ts: '2026-10-12T16:00:00.000Z', text: 'hi', attachments: [good, { id: '../x', kind: 'image', path: '/etc' }, { id: good.id, kind: 'exe', path: '/x' }, 'junk'] }) + '\n');
  assert.deepEqual(orders.readReplies(dir)[0].attachments, [good]);
});
