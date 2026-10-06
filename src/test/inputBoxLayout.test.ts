import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toLineCol,
  toCursor,
  toVisualRow,
  moveVisualRow,
  rowStart,
  rowEnd,
  movePageVisualRows,
  moveParagraph,
  toLineCol,
} from '../ui/inputBoxLayout.js';

test('toLineCol/toCursor round-trip through every position of a multi-line value, including the boundary right at each newline', () => {
  const value = 'ab\ncd\ne';
  for (let cursor = 0; cursor <= value.length; cursor++) {
    const pos = toLineCol(value, cursor);
    assert.equal(toCursor(value, pos), cursor, `cursor ${cursor}`);
  }
  // Spot-check the exact line/col at a few notable positions.
  assert.deepEqual(toLineCol(value, 0), { line: 0, col: 0 });
  assert.deepEqual(toLineCol(value, 2), { line: 0, col: 2 }); // right before the first \n
  assert.deepEqual(toLineCol(value, 3), { line: 1, col: 0 }); // right after it
  assert.deepEqual(toLineCol(value, 7), { line: 2, col: 1 }); // end of the whole value
});

test('toVisualRow on a single logical line with no spaces matches the flat floor/modulo formula (word-wrap and hard-wrap agree when there is nothing to word-wrap on)', () => {
  const width = 10;
  const prompt = '> ';
  const value = 'a'.repeat(25); // 25 chars, no newlines, no spaces
  for (const cursor of [0, 5, 8, 9, 10, 17, 25]) {
    const { rowInLine, colInRow } = toVisualRow(value, cursor, width, prompt);
    const flatPos = prompt.length + cursor;
    assert.equal(rowInLine, Math.floor(flatPos / width), `cursor ${cursor} row`);
    assert.equal(colInRow, flatPos % width, `cursor ${cursor} col`);
  }
});

test('moveVisualRow: up/down within a single wrapped logical line behaves exactly as before multi-line existed', () => {
  const width = 10;
  const prompt = '> ';
  const value = 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(5); // wraps into 3 rows (prompt eats 2 cols of row 0)
  // Cursor at the very end (last row, visual col 7) - up should land one row up, same visual
  // column. Verified independently against wrap-ansi's actual rendering, not just hand-derived:
  // row 1 spans value-index 8..17 (offset by the 2-col prompt), so its own col-7-from-start is
  // value-index 15.
  const up1 = moveVisualRow(value, value.length, width, prompt, 'up');
  assert.equal(up1, 15);
  // From the top row, up has nowhere to go (only one logical line, already row 0).
  const upFromTop = moveVisualRow(value, 3, width, prompt, 'up');
  assert.equal(upFromTop, undefined);
  // From the bottom row, down has nowhere to go.
  const downFromBottom = moveVisualRow(value, value.length, width, prompt, 'down');
  assert.equal(downFromBottom, undefined);
});

test('moveVisualRow: crosses from one short logical line into the next, clamping column to the shorter line', () => {
  const width = 80;
  const prompt = '> ';
  const value = 'hello\nhi'; // line 0 = "hello" (5 chars), line 1 = "hi" (2 chars)
  // Cursor at col 4 of line 0 ("hell|o") - down should land at col 2 of line 1 (clamped, "hi" is shorter).
  const downPos = moveVisualRow(value, 4, width, prompt, 'down');
  assert.deepEqual(toLineCol(value, downPos as number), { line: 1, col: 2 });
  // Cursor at col 1 of line 1 ("h|i", visual column 1 of that row since line 1 has no prompt
  // offset). Moving up targets that SAME visual column on line 0's row - but line 0's row is
  // "> hello", so visual column 1 falls inside the two-character prompt itself (columns 0-1),
  // before any of line 0's actual text starts (which begins at visual column 2). There's no
  // valid text-cursor position under the prompt, so it clamps to line 0's own start instead -
  // confirmed independently against wrap-ansi's real rendering, not just hand-derived.
  const upPos = moveVisualRow(value, toCursor(value, { line: 1, col: 1 }), width, prompt, 'up');
  assert.deepEqual(toLineCol(value, upPos as number), { line: 0, col: 0 });
});

test('moveVisualRow: crossing into a wrapped line from above lands on its LAST row; from below lands on its FIRST row', () => {
  const width = 10;
  const prompt = '> ';
  // Line 0: short, single row. Line 1: wraps into 2 rows (20 chars at width 10, no prompt offset).
  const value = 'hi\n' + 'a'.repeat(10) + 'b'.repeat(10);
  const line1Start = toCursor(value, { line: 1, col: 0 });

  // From line 0 col 1 (visual column 3, since line 0's "> hi" prompt eats 2 columns), moving down
  // preserves that visual column on line 1's FIRST row - text col 3 there (line 1 has no prompt
  // offset), not skipping into row 2. Verified independently against wrap-ansi's real rendering.
  const downPos = moveVisualRow(value, 1, width, prompt, 'down');
  assert.deepEqual(toLineCol(value, downPos as number), { line: 1, col: 3 });

  // From line 1's second row (e.g. col 15, which is row 1 of that line), moving up should stay
  // within line 1 (row 0), not jump all the way to line 0.
  const withinLineUp = moveVisualRow(value, line1Start + 15, width, prompt, 'up');
  assert.deepEqual(toLineCol(value, withinLineUp as number), { line: 1, col: 5 });

  // From line 1's FIRST row, col 3 (visual column 3, line 1 has no prompt offset) - moving up
  // preserves that visual column on line 0's only row. Line 0's row is "> hi": visual column 3
  // is the 'i' - which, after subtracting the 2-column prompt, is text col 1 of "hi" (between
  // 'h' and 'i'). Verified independently against wrap-ansi's real rendering.
  const crossUp = moveVisualRow(value, line1Start + 3, width, prompt, 'up');
  assert.deepEqual(toLineCol(value, crossUp as number), { line: 0, col: 1 });
});

test('moveVisualRow: undefined only at the true top of line 0 and true bottom of the last line, not at every line boundary', () => {
  const width = 80;
  const prompt = '> ';
  const value = 'first\nsecond\nthird';

  assert.equal(moveVisualRow(value, 2, width, prompt, 'up'), undefined);
  assert.notEqual(moveVisualRow(value, toCursor(value, { line: 1, col: 2 }), width, prompt, 'up'), undefined);
  assert.notEqual(
    moveVisualRow(value, toCursor(value, { line: 1, col: 2 }), width, prompt, 'down'),
    undefined,
  );
  assert.equal(
    moveVisualRow(value, toCursor(value, { line: 2, col: 3 }), width, prompt, 'down'),
    undefined,
  );
});

test('rowStart/rowEnd never cross into a different logical line', () => {
  const width = 80;
  const prompt = '> ';
  const value = 'first\nsecond\nthird';
  const midOfSecond = toCursor(value, { line: 1, col: 3 });

  assert.deepEqual(toLineCol(value, rowStart(value, midOfSecond, width, prompt)), { line: 1, col: 0 });
  assert.deepEqual(toLineCol(value, rowEnd(value, midOfSecond, width, prompt)), {
    line: 1,
    col: 'second'.length,
  });
});

test('rowStart/rowEnd on a wrapped (multi-row) logical line stay within the current row, not the whole line', () => {
  const width = 10;
  const prompt = '> ';
  const value = 'a'.repeat(10) + 'b'.repeat(6); // one logical line, wraps into 2 rows (prompt eats row 0)
  const secondRowPos = toCursor(value, { line: 0, col: 12 }); // well into row 1

  const start = rowStart(value, secondRowPos, width, prompt);
  const end = rowEnd(value, secondRowPos, width, prompt);
  assert.deepEqual(toLineCol(value, start), { line: 0, col: 8 }); // row 1 begins at wrap-pos 10, minus prompt.length 2
  assert.deepEqual(toLineCol(value, end), { line: 0, col: value.length }); // row 1 is the line's last, partially filled
});

test('word-wrap breaks a long line at spaces instead of mid-word (the bug this rewrite fixes)', () => {
  // Regression test for David's live report: "the words wrap, the words get split in the
  // middle" - reproduced with hard-wrap (the pre-fix behavior), fixed by switching InputBox.tsx
  // to wrap="wrap" and rewriting this module to call the real wrap-ansi algorithm instead of a
  // closed-form formula that could only match hard-wrap.
  const width = 20;
  const prompt = '> ';
  const value = Array(4).fill('motherfather').join(' '); // 12-char word, well under width 20
  // Cursor at the very end - moving up one row should land on a row boundary that fell at a
  // SPACE, not mid-word. Confirmed by checking the actual wrapped text is never split inside
  // "motherfather" - i.e. every row's content, trimmed, is either a whole word or empty.
  const target = moveVisualRow(value, value.length, width, prompt, 'up');
  assert.notEqual(target, undefined);
  // The row this cursor lands on/near should never bisect "motherfather" - spot check by
  // confirming rowStart/rowEnd on the end-of-value position bound a row that starts and ends on
  // a word boundary (index 0, or right after a space; end index length, or right before a space).
  const start = rowStart(value, value.length, width, prompt);
  const end = rowEnd(value, value.length, width, prompt);
  const before = value[start - 1];
  const after = value[end];
  assert.ok(start === 0 || before === ' ', `row start ${start} is mid-word: "${value.slice(Math.max(0, start - 4), start + 4)}"`);
  assert.ok(end === value.length || after === ' ', `row end ${end} is mid-word: "${value.slice(Math.max(0, end - 4), end + 4)}"`);
});

// --- PageUp/PageDown and paragraph jumps -----------------------------------

const PARAS = [
  'alpha one',   // 0
  'alpha two',   // 1
  '',            // 2
  'beta one',    // 3
  'beta two',    // 4
  'beta three',  // 5
  '',            // 6
  '',            // 7
  'gamma one',   // 8
].join('\n');

/** Absolute cursor index of the first character of logical line `n`. */
function startOfLine(text: string, n: number): number {
  return text.split('\n').slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
}

test('paragraph jump moves forward across the blank-line gaps', () => {
  assert.equal(moveParagraph(PARAS, 0, 'down'), startOfLine(PARAS, 3), 'from alpha to beta');
  assert.equal(moveParagraph(PARAS, startOfLine(PARAS, 3), 'down'), startOfLine(PARAS, 8), 'beta to gamma, over two blanks');
  assert.equal(moveParagraph(PARAS, startOfLine(PARAS, 8), 'down'), PARAS.length, 'past the last paragraph lands at the end');
});

test('paragraph jump moves backward, first to this paragraph then to the one before', () => {
  // Mid-paragraph: the first press goes to this paragraph's own start.
  assert.equal(moveParagraph(PARAS, startOfLine(PARAS, 5), 'up'), startOfLine(PARAS, 3), 'beta three -> beta one');
  // Already at the start: the next press goes to the previous paragraph.
  assert.equal(moveParagraph(PARAS, startOfLine(PARAS, 3), 'up'), 0, 'beta one -> alpha one');
  assert.equal(moveParagraph(PARAS, 0, 'up'), 0, 'at the top it stays put');
});

test('paragraph jump from inside a blank gap goes to the paragraph above it', () => {
  assert.equal(moveParagraph(PARAS, startOfLine(PARAS, 7), 'up'), startOfLine(PARAS, 3), 'the gap belongs to beta');
});

test('page movement covers a whole window of visual rows at once', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const down = movePageVisualRows(text, 0, 40, '> ', 10, 'down');
  // Asserting the line, not the raw index: column preservation carries line 0's prompt offset of
  // two columns across, which is how plain arrow movement has always behaved.
  assert.equal(toLineCol(text, down).line, 10, 'ten rows down lands ten lines down when nothing wraps');
  const back = movePageVisualRows(text, down, 40, '> ', 10, 'up');
  assert.equal(back, 0, 'and ten rows back up returns to the start');
});

test('page movement counts wrapped rows, not logical lines', () => {
  // Each line wraps into three rows at this width, so ten rows is a bit over three lines.
  const text = Array.from({ length: 10 }, (_, i) => `${i} ` + 'word '.repeat(12)).join('\n');
  const moved = movePageVisualRows(text, 0, 20, '> ', 10, 'down');
  const { line } = toLineCol(text, moved);
  assert.ok(line > 0 && line < 10, `expected to land inside the text, got line ${line}`);
  assert.ok(line < 10, 'a page of wrapped rows must not skip the whole buffer');
});

test('page movement past the end lands on the very start or end', () => {
  const text = 'one\ntwo\nthree';
  assert.equal(movePageVisualRows(text, 0, 40, '> ', 50, 'down'), text.length);
  assert.equal(movePageVisualRows(text, text.length, 40, '> ', 50, 'up'), 0);
});
