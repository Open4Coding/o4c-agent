import test from 'node:test';
import assert from 'node:assert/strict';
import { theme, lineStyle, contextBarStyle } from '../ui/theme.js';
import { CONTEXT_PRESSURE_RATIO } from '../agent/loop.js';
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
});

test('neither a tool call nor its result keeps the bronze they used to share with system', () => {
  assert.notEqual(lineStyle.tool_call.color, theme.border);
  assert.notEqual(lineStyle.tool_result.color, theme.border);
});

// Asked for 2026-10-11: the call line leads at full brightness, the output sits a step behind it.
// The call is what you scan FOR when reading a transcript back; its output is bulk you read only
// once you have found the call - so they must not be one weight.
test('a tool call is bright white and its output stays the dimmed white', () => {
  assert.equal(lineStyle.tool_call.color, theme.toolCall);
  assert.equal(theme.toolCall, '#FFFFFF');
  assert.equal(lineStyle.tool_result.color, theme.tool);
  assert.equal(theme.tool, '#CCC6B0');
  assert.notEqual(lineStyle.tool_call.color, lineStyle.tool_result.color);
});

// "Dimmed" is the whole point of the token, so it is worth asserting rather than trusting the hex:
// it has to be darker than `text` (or it is not dimmed) and lighter than the background (or it is
// not readable). Compared on a plain channel sum, which is enough to order two warm greys.
test('the tool output color sits between the background and the theme white', () => {
  const sum = (hex: string): number =>
    parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  assert.ok(sum(theme.tool) < sum(theme.text), 'tool output should be dimmer than text');
  assert.ok(sum(theme.tool) > sum(theme.bg) + 150, 'tool output should stay well clear of the background');
  // And the call line is brighter than its output, which is the whole shape of the pairing.
  assert.ok(sum(theme.toolCall) > sum(theme.tool), 'a tool call should be brighter than its output');
});

// Front-end checklist #13: the bar has to agree with the engine, so this asserts against the
// engine's own exported threshold rather than a literal 0.8 copied over here.
test('the context bar goes red at the share where the loop starts pausing to compact', () => {
  const over = contextBarStyle(CONTEXT_PRESSURE_RATIO, CONTEXT_PRESSURE_RATIO);
  assert.equal(over.bar, theme.error);
  assert.equal(over.percent, theme.error);
});

test('below the line the bar keeps the colours it has always had', () => {
  const under = contextBarStyle(CONTEXT_PRESSURE_RATIO - 0.01, CONTEXT_PRESSURE_RATIO);
  assert.equal(under.bar, theme.warn);
  assert.equal(under.percent, theme.accent);
  // Including an empty session, which must not look like a problem.
  assert.equal(contextBarStyle(0, CONTEXT_PRESSURE_RATIO).bar, theme.warn);
});

// The boundary is inclusive on purpose - the loop's own gate is `>=`, so a bar that waited for
// 81% would stay reassuring through the exact turn that paused to compact.
test('the threshold is inclusive, matching the gate the loop actually applies', () => {
  assert.equal(contextBarStyle(CONTEXT_PRESSURE_RATIO, CONTEXT_PRESSURE_RATIO).bar, theme.error);
  assert.equal(contextBarStyle(0.7999, 0.8).bar, theme.warn);
});

// An estimate that overshoots the window is a real state, not a bug: chars/4 is approximate and
// the gate reports what it sees. The bar must stay red rather than wrapping around to calm.
test('an over-full estimate stays red rather than wrapping around', () => {
  assert.equal(contextBarStyle(1.31, CONTEXT_PRESSURE_RATIO).bar, theme.error);
});
