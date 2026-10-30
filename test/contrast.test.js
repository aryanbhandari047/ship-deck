'use strict';
// The Chart room palette must pass WCAG AA in both themes: 4.5:1 for every text pair the UI
// uses, read straight from the tokens in public/style.css (light :root and the dark override).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) out[m[1]] = m[2];
  return out;
}
const light = tokens(/:root \{([\s\S]*?)\n\}/.exec(css)[1]);
const dark = { ...light, ...tokens(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css)[1]) };

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const PAIRS = [
  ['ink', 'surface'], ['ink-2', 'surface'], ['ink-3', 'surface'],
  ['ink', 'canvas'], ['ink-2', 'canvas'], ['ink-3', 'canvas'],
  ['ink-3', 'surface-2'], ['ink-2', 'sunken'],
  ['on-primary', 'primary'], ['primary', 'surface'], ['primary', 'canvas'],
  ...['needs', 'blocked', 'failed', 'working', 'waiting', 'done', 'quiet'].map((t) => [`${t}-fg`, `${t}-bg`]),
  ['done-fg', 'surface'], ['blocked-fg', 'surface'],
  // compact board cards print their status word in the tone's colour straight on the card
  ['working-fg', 'surface'], ['waiting-fg', 'surface'], ['quiet-fg', 'surface'],
  ['term-fg', 'term-bg'], ['term-dim', 'term-bg'],
];

for (const [name, theme] of [['light', light], ['dark', dark]]) {
  test(`${name} theme: every text pair passes AA (4.5:1)`, () => {
    for (const [fg, bg] of PAIRS) {
      assert.ok(theme[fg] && theme[bg], `missing token ${fg} or ${bg}`);
      const r = ratio(theme[fg], theme[bg]);
      assert.ok(r >= 4.5, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    }
  });
}

test('the dark override really changes the palette', () => {
  assert.notEqual(light.canvas, dark.canvas);
  assert.notEqual(light.ink, dark.ink);
  // the prefers-color-scheme block carries the same values as [data-theme="dark"]
  const auto = tokens(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)[1]);
  for (const [k, v] of Object.entries(auto)) assert.equal(dark[k], v, `--${k} differs between the two dark blocks`);
});
