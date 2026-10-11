import test from 'node:test';
import assert from 'node:assert/strict';
import { theme, lineStyle } from '../ui/theme.js';
import type { LineKind } from '../ui/types.js';

// Why these are asserted on the map rather than on a rendered frame: ink-testing-library renders
// with color disabled, so `lastFrame()` comes back as plain text with no escape codes - there is
// nothing in a frame to assert a color against.

const ALL_KINDS: LineKind[] = [
  'system',
  'user',
  'tool_call',
  'tool_result',
  'final',
  'error',
  'splash',
];

test('a user line is green, the color sampled from Claude Code (2026-10-11 request)', () => {
  assert.equal(lineStyle.user.color, '#6AA167');
  assert.equal(lineStyle.user.color, theme.user);
});

test('a user line no longer shares a color with the model response - the point of the change', () => {
  assert.notEqual(lineStyle.user.color, lineStyle.final.color);
  assert.notEqual(lineStyle.user.color, theme.accent);
});

test('every line kind has a style, so LineText can index the map without a fallback', () => {
  for (const kind of ALL_KINDS) {
    assert.ok(lineStyle[kind], `no style for ${kind}`);
    assert.match(lineStyle[kind].color, /^#[0-9a-fA-F]{6}$/);
  }
  assert.equal(Object.keys(lineStyle).length, ALL_KINDS.length);
});

test('the kinds that were not meant to change kept their colors', () => {
  assert.equal(lineStyle.final.color, theme.accent);
  assert.equal(lineStyle.final.bold, true);
  assert.equal(lineStyle.error.color, theme.error);
  assert.equal(lineStyle.splash.color, theme.primary);
  assert.equal(lineStyle.system.color, theme.border);
  assert.equal(lineStyle.tool_call.color, theme.border);
  assert.equal(lineStyle.tool_result.color, theme.border);
});
