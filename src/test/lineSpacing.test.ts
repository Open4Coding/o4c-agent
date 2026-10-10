import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsGapBefore } from '../ui/lineSpacing.js';
import type { Line } from '../ui/types.js';

const user = (text: string): Line => ({ kind: 'user', text });
const system = (text: string): Line => ({ kind: 'system', text });
const toolCall: Line = { kind: 'tool_call', text: '[tool] read_file({})' };
const toolResult: Line = { kind: 'tool_result', text: '[result] ok' };
const final = (text: string): Line => ({ kind: 'final', text });

test('a [think] line under the prompt or under narration gets a blank row before it', () => {
  assert.equal(needsGapBefore(user('> build it'), system('[think] plan')), true);
  assert.equal(needsGapBefore(system('some narration'), system('[think] more')), true);
});

test('a [tool] line directly under reasoning text gets a gap', () => {
  assert.equal(needsGapBefore(system('[think] plan'), toolCall), true);
});

test('a line right after a tool call or result gets no extra gap - those already end with a blank row', () => {
  assert.equal(needsGapBefore(toolCall, toolResult), false);
  assert.equal(needsGapBefore(toolResult, system('[think] next')), false);
  assert.equal(needsGapBefore(toolResult, system('[scan] 6 more tool calls collapsed')), false);
});

test('the first line of a block never gets a gap', () => {
  assert.equal(needsGapBefore(undefined, system('[think] first')), false);
});

test('text right AFTER a labelled line gets a gap too - the final answer or narration must not be glued to a [think]', () => {
  assert.equal(needsGapBefore(system('[think] the file has been written'), final('Done - the game is in index.html')), true);
  assert.equal(needsGapBefore(system('[think] plan'), system('some narration')), true);
  assert.equal(needsGapBefore(system('[scan] 6 more tool calls collapsed'), final('All done.')), true);
});

test('two ordinary lines (prompt then narration, narration then answer) stay together - neither is labelled', () => {
  assert.equal(needsGapBefore(user('> hi'), system('plain narration')), false);
  assert.equal(needsGapBefore(system('narration'), final('the answer')), false);
  assert.equal(needsGapBefore(system('x'), system('[not a known label] y')), false);
});

test('the other labelled lines get a gap too', () => {
  for (const label of ['scan', 'compact', 'prune', 'warning']) {
    assert.equal(needsGapBefore(final('x'), system('[' + label + '] y')), true, label);
  }
});

test('a line after a blank row gets no second one', () => {
  assert.equal(needsGapBefore({ kind: 'system', text: ' ' }, { kind: 'system', text: '[think] x' }), false);
  assert.equal(needsGapBefore({ kind: 'system', text: '' }, { kind: 'tool_call', text: '[tool] run_shell' }), false);
});
