'use strict';
// Drawer helpers that run in the page: the terminal peek's SGR-to-class parser
// (public/ansi.js) and the settings picker's preselect (public/labels.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const ansi = require('../public/ansi');
const labels = require('../public/labels');

const E = '\x1b';
const text = (segs) => segs.map((s) => s.text).join('');

test('plain text is one unstyled segment', () => {
  assert.deepEqual(ansi.parse('hello\nworld\t!'), [{ text: 'hello\nworld\t!', cls: '' }]);
  assert.deepEqual(ansi.parse(''), []);
  assert.deepEqual(ansi.parse(null), []);
});

test('basic, bright, background and style codes become class names', () => {
  const segs = ansi.parse(`${E}[1;32mok${E}[0m plain ${E}[91;44mhot${E}[22;39;49m done ${E}[2;3;4;9mx`);
  assert.deepEqual(segs, [
    { text: 'ok', cls: 'fg-2 t-b' },
    { text: ' plain ', cls: '' },
    { text: 'hot', cls: 'fg-9 bg-4' },
    { text: ' done ', cls: '' },
    { text: 'x', cls: 't-d t-i t-u t-s' },
  ]);
});

test('256-colour and truecolour map onto the 16 base classes', () => {
  assert.equal(ansi.parse(`${E}[38;5;1mr`)[0].cls, 'fg-1');
  assert.equal(ansi.parse(`${E}[38;5;196mr`)[0].cls, 'fg-9');
  assert.equal(ansi.parse(`${E}[48;5;232mr`)[0].cls, 'bg-0');
  assert.equal(ansi.parse(`${E}[38;2;0;200;0mg`)[0].cls, 'fg-10');
  assert.equal(ansi.parse(`${E}[38:2:0:0:120mb`)[0].cls, 'fg-4'); // colon form
  // out-of-range or truncated extended colours are ignored, not crashing
  assert.equal(ansi.parse(`${E}[38;5;999mx`)[0].cls, '');
  assert.equal(ansi.parse(`${E}[38;2;1mx`)[0].cls, '');
  assert.equal(ansi.parse(`${E}[38mx`)[0].cls, '');
});

test('inverse swaps colours, using rev for the default ones', () => {
  assert.equal(ansi.parse(`${E}[7mx`)[0].cls, 'fg-rev bg-rev');
  assert.equal(ansi.parse(`${E}[31;7mx`)[0].cls, 'fg-rev bg-1');
  assert.equal(ansi.parse(`${E}[31;42;7mx${E}[27my`).map((s) => s.cls).join('|'), 'fg-2 bg-1|fg-1 bg-2');
});

test('unclosed codes carry to the end and never leak escape bytes', () => {
  const segs = ansi.parse(`${E}[31mred\nstill red`);
  assert.deepEqual(segs, [{ text: 'red\nstill red', cls: 'fg-1' }]);
  // a sequence cut off at the end of the capture is dropped
  for (const tail of [`${E}`, `${E}[`, `${E}[38;5`, `${E}]8;;https://x`, `${E}P1$r`]) {
    assert.equal(text(ansi.parse('ok' + tail)), 'ok', JSON.stringify(tail));
  }
});

test('malicious sequences: OSC links, titles, other CSI and controls are stripped', () => {
  const evil = `${E}]0;pwned title\x07${E}]8;;javascript:alert(1)${E}\\click${E}]8;;${E}\\`
    + `${E}[2J${E}[H${E}[?1049h${E}[6n${E}P+q544e${E}\\${E}_apc${E}\\${E}c${E}(B`
    + `\x00\x07\x08\x9b31m<img src=x onerror=alert(1)>`;
  const segs = ansi.parse(evil);
  assert.equal(text(segs), 'click31m<img src=x onerror=alert(1)>');
  assert.ok(segs.every((s) => /^[a-z0-9 -]*$/.test(s.cls)), 'classes are only our names');
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text(segs)));
  // private-mode "m" and huge parameter lists are ignored safely
  assert.equal(ansi.parse(`${E}[>4;2mx`)[0].cls, '');
  const many = `${E}[${'1;'.repeat(5000)}31mx`;
  assert.equal(ansi.parse(many)[0].text, 'x');
  assert.equal(ansi.parse(`${E}[99999999999999999999mx`)[0].cls, '');
});

test('classes only come from a fixed vocabulary', () => {
  const ok = /^(fg-(\d{1,2}|rev)|bg-(\d{1,2}|rev)|t-[bdius])$/;
  let s = '';
  for (let n = 0; n < 110; n++) s += `${E}[${n}m${n}`;
  for (let n = 0; n < 256; n += 7) s += `${E}[38;5;${n};48;5;${255 - n}m.`;
  for (const seg of ansi.parse(s)) for (const c of seg.cls.split(' ').filter(Boolean)) {
    assert.match(c, ok);
    const m = /-(\d+)$/.exec(c);
    if (m) assert.ok(Number(m[1]) <= 15, c);
  }
});

test('settings picker preselects the current value and leaves it out of the choices', () => {
  const list = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'];
  const a = labels.configChoices(list, 'default');
  assert.equal(a.selected, '');
  assert.deepEqual(a.options[0], ['', 'Current (default)']);
  assert.deepEqual(a.options.slice(1).map((o) => o[0]), list, 'no allow-listed model is preselected');
  assert.equal(labels.configChoices(list, null).options[0][1], 'Current (default)');

  const b = labels.configChoices(list, 'claude-sonnet-5');
  assert.deepEqual(b.options.map((o) => o[0]), ['', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1']);
  assert.equal(b.options[0][1], 'Current (claude-sonnet-5)');

  const c = labels.configChoices(['low', 'high'], 'high', 'low');
  assert.deepEqual(c.options, [['', 'Current (high, low on relaunch)']]);
});
