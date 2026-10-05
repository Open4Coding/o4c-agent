import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialTextWindow,
  makeBlock,
  rowsFor,
  shouldFlushDelta,
  textWindowReducer,
  trimLiveToRows,
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

test('appendDelta on an empty live region starts a new line', () => {
  const state = textWindowReducer(initialTextWindow(), { type: 'appendDelta', text: 'Hel' });
  assert.deepEqual(state.live, ['Hel']);
  assert.equal(state.deltaActive, true);
});

test('appendDelta while active grows the same line instead of adding a new one', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendDelta', text: 'Hel' });
  state = textWindowReducer(state, { type: 'appendDelta', text: 'lo' });
  state = textWindowReducer(state, { type: 'appendDelta', text: ', world' });
  assert.deepEqual(state.live, ['Hello, world']);
});

test('appendDelta with startNewLine forces a fresh line even mid-stream (deltaActive true)', () => {
  // The real case this is for: a delta stream transitioning kind (reasoning ending, the real
  // answer beginning) mid-turn - deltaActive stays true across that transition (it's still one
  // continuous 'delta' stream from AgentLoop's perspective), so without startNewLine the answer's
  // first chunk would just run on from the end of the reasoning line.
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendDelta', text: '[think] reasoning...' });
  state = textWindowReducer(state, { type: 'appendDelta', text: 'the answer', startNewLine: true });
  assert.deepEqual(state.live, ['[think] reasoning...', 'the answer']);
  // And it keeps growing normally on subsequent chunks, same as any other delta run.
  state = textWindowReducer(state, { type: 'appendDelta', text: ' continues' });
  assert.deepEqual(state.live, ['[think] reasoning...', 'the answer continues']);
});

test('appendLive after an active delta stream starts a fresh line, not a continuation', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendDelta', text: 'streamed' });
  state = textWindowReducer(state, { type: 'appendLive', text: '[tool] read_file(...)' });
  assert.deepEqual(state.live, ['streamed', '[tool] read_file(...)']);
  assert.equal(state.deltaActive, false);
});

test('a second delta run (a new provider call) starts its own new line, not a continuation of the first', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendDelta', text: 'first call' });
  state = textWindowReducer(state, { type: 'appendLive', text: '[tool] x()' }); // ends the first run
  state = textWindowReducer(state, { type: 'appendDelta', text: 'second call' });
  assert.deepEqual(state.live, ['first call', '[tool] x()', 'second call']);
});

test('clearLive resets deltaActive - a delta right after starts a brand new line', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendDelta', text: 'turn 1' });
  state = textWindowReducer(state, { type: 'clearLive' });
  state = textWindowReducer(state, { type: 'appendDelta', text: 'turn 2' });
  assert.deepEqual(state.live, ['turn 2']);
});

test('updateScanSummary also ends an active delta run', () => {
  let state = initialTextWindow();
  state = textWindowReducer(state, { type: 'appendDelta', text: 'streamed' });
  state = textWindowReducer(state, { type: 'updateScanSummary', text: '[scan] 3 collapsed' });
  assert.equal(state.deltaActive, false);
  state = textWindowReducer(state, { type: 'appendDelta', text: 'next' });
  assert.deepEqual(state.live, ['streamed', '[scan] 3 collapsed', 'next']);
});

test('shouldFlushDelta holds back a short buffer', () => {
  assert.equal(shouldFlushDelta('just a few words', 80), false);
  assert.equal(shouldFlushDelta('', 80), false);
});

test('shouldFlushDelta flushes once 5 newlines are buffered', () => {
  assert.equal(shouldFlushDelta('a\nb\nc\nd\n', 80), false);
  assert.equal(shouldFlushDelta('a\nb\nc\nd\ne\n', 80), true);
});

test('shouldFlushDelta flushes once 5 terminal widths of characters are buffered', () => {
  assert.equal(shouldFlushDelta('x'.repeat(5 * 80 - 1), 80), false);
  assert.equal(shouldFlushDelta('x'.repeat(5 * 80), 80), true);
  assert.equal(shouldFlushDelta('x'.repeat(5 * 120 - 1), 120), false);
});

test('shouldFlushDelta survives a degenerate terminal width', () => {
  assert.equal(shouldFlushDelta('abcde', 0), true);
});

test('rowsFor counts wrapped rows per newline-separated segment, minimum one each', () => {
  assert.equal(rowsFor('', 80), 1);
  assert.equal(rowsFor('x'.repeat(80), 80), 1);
  assert.equal(rowsFor('x'.repeat(81), 80), 2);
  assert.equal(rowsFor('a\nb\nc', 80), 3);
  assert.equal(rowsFor('a\n\nb', 80), 3);
});

test('trimLiveToRows leaves a region that already fits untouched', () => {
  assert.deepEqual(trimLiveToRows(['one', 'two\nthree'], 10, 80), ['one', 'two\nthree']);
});

test('trimLiveToRows drops whole oldest entries first, keeping the newest', () => {
  assert.deepEqual(trimLiveToRows(['a', 'b', 'c', 'd'], 2, 80), ['c', 'd']);
});

test('trimLiveToRows bounds many-short-lines text that the char cap would let through', () => {
  const manyShortLines = Array.from({ length: 100 }, (_, i) => 'l' + i).join('\n');
  const out = trimLiveToRows([manyShortLines], 20, 177);
  assert.ok(rowsFor(out.join('\n'), 177) <= 20);
  assert.ok(out[0].endsWith('l99'));
});

test('trimLiveToRows cuts one huge wrapped line to its trailing rows', () => {
  const out = trimLiveToRows(['y'.repeat(1000)], 3, 80);
  assert.equal(out.length, 1);
  assert.ok(rowsFor(out[0], 80) <= 3);
  assert.equal(out[0].length, 240);
});

test('the reducer applies the row cap to streamed deltas when the state carries one', () => {
  let state = initialTextWindow([], 1000000, 5, 80);
  for (let i = 0; i < 50; i++) state = textWindowReducer(state, { type: 'appendDelta', text: 'line ' + i + '\n' });
  assert.ok(rowsFor(state.live.join('\n'), 80) <= 5);
  assert.ok(state.live.join('').includes('line 49'));
});

test('reset keeps the live caps instead of falling back to the default budget', () => {
  const state = initialTextWindow([], 1234, 7, 90);
  const after = textWindowReducer(state, { type: 'reset', blocks: [] });
  assert.equal(after.liveCapChars, 1234);
  assert.equal(after.liveCapRows, 7);
  assert.equal(after.liveCols, 90);
});

test('setLiveCaps re-bounds the live region to a smaller terminal, keeping the newest rows', () => {
  let state = initialTextWindow([], 100000, 50, 80);
  for (let i = 0; i < 40; i++) state = textWindowReducer(state, { type: 'appendLive', text: `line ${i}` });
  assert.equal(state.live.length, 40);
  const shrunk = textWindowReducer(state, { type: 'setLiveCaps', liveCapChars: 100000, liveCapRows: 10, liveCols: 80 });
  assert.ok(rowsFor(shrunk.live.join('\n'), 80) <= 10, 'live region must fit the new row cap');
  assert.equal(shrunk.live.at(-1), 'line 39', 'the newest content is kept');
  assert.equal(shrunk.liveCapRows, 10);
});
