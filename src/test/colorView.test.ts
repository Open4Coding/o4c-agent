import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSI_HUES,
  SAMPLE_TEXT,
  ansiColorLines,
  brightName,
  colorViewLines,
  themeColorLines,
} from '../ui/colorView.js';
import { theme } from '../ui/theme.js';

test('every hue appears twice - dark then light - and no hue is missing', () => {
  const lines = ansiColorLines();
  assert.equal(lines.length, ANSI_HUES.length * 2);
  assert.equal(lines.length, 16);
  ANSI_HUES.forEach((hue, i) => {
    const dark = lines[i * 2];
    const light = lines[i * 2 + 1];
    assert.equal(dark.color, hue);
    assert.equal(light.color, brightName(hue));
    assert.match(dark.text, /\bdark\b/);
    assert.match(light.text, /\blight\b/);
  });
});

test('each row is drawn in the color it names, which is the whole point', () => {
  for (const line of [...ansiColorLines(), ...themeColorLines()]) {
    assert.ok(line.color, `row has no color: ${line.text}`);
    assert.match(line.text, new RegExp(SAMPLE_TEXT));
  }
});

test('the ansi codes are the standard ones, 30-37 dark and 90-97 light', () => {
  const lines = ansiColorLines();
  ANSI_HUES.forEach((_, i) => {
    assert.match(lines[i * 2].text, new RegExp(`ansi ${30 + i}$`));
    assert.match(lines[i * 2 + 1].text, new RegExp(`ansi ${90 + i}$`));
  });
});

test('every theme token is listed, drawn in its own hex', () => {
  const lines = themeColorLines();
  assert.equal(lines.length, Object.keys(theme).length);
  for (const [name, hex] of Object.entries(theme)) {
    const line = lines.find((l) => l.text.includes(name));
    assert.ok(line, `no row for theme.${name}`);
    assert.equal(line.color, hex);
    // bg alone carries a trailing note, so the hex is present rather than last.
    assert.ok(line.text.includes(hex));
    if (name !== 'bg') assert.ok(line.text.endsWith(hex));
  }
});

test('the green added on 2026-10-11 is in the chart', () => {
  const line = themeColorLines().find((l) => l.color === '#6AA167');
  assert.ok(line);
  assert.match(line.text, /\buser\b/);
});

test('the block counts itself correctly in its own header', () => {
  const header = colorViewLines()[0].text;
  assert.match(header, /16 named/);
  assert.match(header, new RegExp(`${Object.keys(theme).length} theme tokens`));
  assert.match(header, /ansi256/);
});

test('the sample text is left-aligned in one column, so colors compare down the page', () => {
  const rows = [...ansiColorLines(), ...themeColorLines()];
  const starts = new Set(rows.map((r) => r.text.indexOf(SAMPLE_TEXT)));
  assert.equal(starts.size, 1);
});
