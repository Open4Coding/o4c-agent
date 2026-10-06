import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_CHROME_ROWS,
  FRAME_SPARE_ROWS,
  MIN_LIVE_REGION_ROWS,
  MAX_INPUT_BOX_ROWS,
  MIN_INPUT_BOX_ROWS,
  expandedInputBoxCapRows,
  inputBoxCapRows,
  liveRegionCapRowsFor,
  liveRegionCapChars,
  liveRegionCapRows,
} from '../ui/frameBudget.js';

/** Every terminal height worth caring about, plus the degenerate ones. */
const HEIGHTS = [8, 10, 12, 15, 20, 24, 30, 40, 50, 60, 80, 100, 114, 200];

test('the two growable parts plus chrome never sum past the viewport', () => {
  for (const rows of HEIGHTS) {
    const total = inputBoxCapRows(rows) + liveRegionCapRows(rows) + FRAME_CHROME_ROWS;
    // This is the whole point of the module: a frame at or above the viewport height cannot be
    // erased in place, so the budgets must leave at least one row spare at every height.
    assert.ok(
      total < rows || rows <= FRAME_CHROME_ROWS + MIN_INPUT_BOX_ROWS,
      `at ${rows} rows the budgets sum to ${total}, which does not fit`,
    );
  }
});

test('the input box cap stays within its bounds at every height', () => {
  for (const rows of HEIGHTS) {
    const cap = inputBoxCapRows(rows);
    assert.ok(cap >= MIN_INPUT_BOX_ROWS, `cap ${cap} below the minimum at ${rows} rows`);
    assert.ok(cap <= MAX_INPUT_BOX_ROWS, `cap ${cap} above the maximum at ${rows} rows`);
  }
});

test('the input box cap grows with the terminal, then stops at the maximum', () => {
  assert.equal(inputBoxCapRows(30), 6, 'a 30-row terminal gives the box a third of its usable rows');
  assert.equal(inputBoxCapRows(60), MAX_INPUT_BOX_ROWS, 'a 60-row terminal reaches the ceiling');
  assert.equal(inputBoxCapRows(114), MAX_INPUT_BOX_ROWS, 'and a very tall one does not exceed it');
  assert.ok(inputBoxCapRows(30) < inputBoxCapRows(50), 'the cap must grow with the terminal');
});

test('the live region gets the rest, and never less than one row', () => {
  assert.equal(liveRegionCapRows(114), 114 - FRAME_CHROME_ROWS - MAX_INPUT_BOX_ROWS - FRAME_SPARE_ROWS);
  assert.equal(liveRegionCapRows(30), 30 - FRAME_CHROME_ROWS - 6 - FRAME_SPARE_ROWS);
  for (const rows of HEIGHTS) {
    assert.ok(liveRegionCapRows(rows) >= 1, `no rows left for streamed output at ${rows} rows`);
  }
});

test('an unknown terminal size falls back to a usable default rather than zero', () => {
  assert.equal(inputBoxCapRows(undefined), inputBoxCapRows(30));
  assert.equal(liveRegionCapRows(undefined), liveRegionCapRows(30));
  assert.ok(liveRegionCapChars(undefined, undefined) >= 800);
});

test('the character budget tracks the row budget and the terminal width', () => {
  assert.ok(liveRegionCapChars(114, 200) > liveRegionCapChars(114, 80), 'a wider terminal holds more');
  assert.ok(liveRegionCapChars(114, 80) > liveRegionCapChars(30, 80), 'a taller terminal holds more');
  assert.ok(liveRegionCapChars(8, 20) >= 800, 'a floor applies however small the terminal');
});

test('an expanded box targets 80% of the screen on a terminal tall enough for it', () => {
  assert.equal(expandedInputBoxCapRows(114), Math.floor(114 * 0.8), 'a 114-row terminal gets the full 80%');
  assert.equal(expandedInputBoxCapRows(100), 80);
  assert.ok(expandedInputBoxCapRows(114) > inputBoxCapRows(114), 'expanding must actually make the box bigger');
});

test('a short terminal gets what is left rather than a literal 80%', () => {
  // 80% of 30 is 24, which would leave nothing for chrome or a streaming turn.
  assert.ok(expandedInputBoxCapRows(30) < 24, 'the 80% target must give way to the subtraction');
  assert.equal(expandedInputBoxCapRows(30), 30 - FRAME_CHROME_ROWS - FRAME_SPARE_ROWS - MIN_LIVE_REGION_ROWS);
});

test('an expanded box plus its shrunken live region still comes out under the viewport', () => {
  for (const rows of HEIGHTS) {
    const box = expandedInputBoxCapRows(rows);
    const live = liveRegionCapRowsFor(rows, box);
    const total = box + live + FRAME_CHROME_ROWS;
    assert.ok(
      total < rows || rows <= FRAME_CHROME_ROWS + MIN_INPUT_BOX_ROWS,
      `expanded at ${rows} rows sums to ${total}, which does not fit`,
    );
    assert.ok(live >= MIN_LIVE_REGION_ROWS, `a streaming turn gets no rows at ${rows} rows`);
  }
});

test('expanding shrinks the live region by what the box gained', () => {
  const collapsed = liveRegionCapRowsFor(114, inputBoxCapRows(114));
  const expanded = liveRegionCapRowsFor(114, expandedInputBoxCapRows(114));
  assert.ok(expanded < collapsed, 'the live region must give up rows when the box takes them');
  assert.equal(
    collapsed - expanded,
    expandedInputBoxCapRows(114) - inputBoxCapRows(114),
    'and give up exactly what the box gained, so the total is unchanged',
  );
});
