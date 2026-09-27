import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialTextWindow,
  makeBlock,
  textWindowReducer,
  type TextWindowState,
} from '../ui/textWindow.js';
import type { Line } from '../ui/types.js';

function line(text: string): Line {
  return { kind: 'system', text };
}

test('initialTextWindow with no blocks starts empty with nextId 0', () => {
  const state = initialTextWindow();
  assert.deepEqual(state.blocks, []);
  assert.deepEqual(state.live, []);
  assert.equal(state.nextId, 0);
});

test('initialTextWindow seeded with existing blocks picks nextId up after the highest one', () => {
  const state = initialTextWindow([makeBlock(0, [line('a')]), makeBlock(4, [line('b')])]);
  assert.equal(state.nextId, 5);
});

test('commit appends a new block with the state\'s own nextId, and increments it', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'commit', lines: [line('first')] });
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0].id, 0);
  assert.equal(state.nextId, 1);

  state = textWindowReducer(state, { type: 'commit', lines: [line('second')] });
  assert.equal(state.blocks.length, 2);
  assert.equal(state.blocks[1].id, 1);
  assert.equal(state.nextId, 2);
});

test('commit with an empty lines array is a no-op - no empty block, no id consumed', () => {
  const state = initialTextWindow();
  const next = textWindowReducer(state, { type: 'commit', lines: [] });
  assert.equal(next, state);
});

test('appendLive adds to the live region without touching blocks', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendLive', text: 'a' });
  state = textWindowReducer(state, { type: 'appendLive', text: 'b' });
  assert.deepEqual(state.live, ['a', 'b']);
  assert.deepEqual(state.blocks, []);
});

test('updateScanSummary replaces a previous [scan] line rather than accumulating one per call', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendLive', text: 'reading files...' });
  state = textWindowReducer(state, { type: 'updateScanSummary', text: '[scan] 3 more tool calls collapsed' });
  state = textWindowReducer(state, { type: 'updateScanSummary', text: '[scan] 7 more tool calls collapsed' });
  assert.deepEqual(state.live, ['reading files...', '[scan] 7 more tool calls collapsed']);
});

test('clearLive empties the live region and is a no-op (same reference) when already empty', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendLive', text: 'x' });
  const cleared = textWindowReducer(state, { type: 'clearLive' });
  assert.deepEqual(cleared.live, []);

  const idempotent = textWindowReducer(cleared, { type: 'clearLive' });
  assert.equal(idempotent, cleared);
});

test('reset replaces the whole window, including live, and re-derives nextId from the new blocks', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'commit', lines: [line('old')] });
  state = textWindowReducer(state, { type: 'appendLive', text: 'stray' });

  const seeded = [makeBlock(0, [line('restored')])];
  const next = textWindowReducer(state, { type: 'reset', blocks: seeded });
  assert.deepEqual(next.blocks, seeded);
  assert.deepEqual(next.live, []);
  assert.equal(next.nextId, 1);
});

test('two independently-created windows never share ids - no module-level counter leakage', () => {
  const a: TextWindowState = textWindowReducer(initialTextWindow(), { type: 'commit', lines: [line('a')] });
  const b: TextWindowState = textWindowReducer(initialTextWindow(), { type: 'commit', lines: [line('b')] });
  assert.equal(a.blocks[0].id, 0);
  assert.equal(b.blocks[0].id, 0);
});
