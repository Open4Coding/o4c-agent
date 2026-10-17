import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ELISION,
  MAX_DIFF_LINES,
  clipDiff,
  diffLines,
  diffStats,
  formatDiffStats,
  splitLines,
  type DiffLine,
} from '../ui/lineDiff.js';

/** `-a +b  c` shorthand, so the expectations below read like a diff instead of like JSON. */
function render(lines: readonly DiffLine[]): string[] {
  return lines.map((l) => `${l.kind === 'removed' ? '-' : l.kind === 'added' ? '+' : ' '}${l.text}`);
}

test('splitLines does not invent a trailing empty line', () => {
  // A file that ends in a newline has N lines, not N+1 - otherwise every write to such a file
  // shows a spurious change on the last line.
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('an unchanged file produces no additions or removals', () => {
  const lines = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepEqual(diffStats(lines), { added: 0, removed: 0 });
  assert.equal(formatDiffStats(diffStats(lines)), 'no change');
});

test('a new file is all additions', () => {
  // Special-cased before the size guard so creating a large file still reads as additions rather
  // than as replacing nothing.
  assert.deepEqual(render(diffLines('', 'a\nb\n')), ['+a', '+b']);
});

test('deleting all content is all removals', () => {
  assert.deepEqual(render(diffLines('a\nb\n', '')), ['-a', '-b']);
});

test('a changed line shows the removal BEFORE the addition', () => {
  // Item 8 in its own words: "removed lines red, added lines green below them".
  assert.deepEqual(render(diffLines('a\nold\nc\n', 'a\nnew\nc\n')), [' a', '-old', '+new', ' c']);
});

test('an inserted line is an addition and nothing else', () => {
  assert.deepEqual(render(diffLines('a\nc\n', 'a\nb\nc\n')), [' a', '+b', ' c']);
});

test('a deleted line is a removal and nothing else', () => {
  assert.deepEqual(render(diffLines('a\nb\nc\n', 'a\nc\n')), [' a', '-b', ' c']);
});

test('a moved line is not reported as unchanged', () => {
  const lines = diffLines('a\nb\n', 'b\na\n');
  const stats = diffStats(lines);
  assert.ok(stats.added > 0 && stats.removed > 0, 'a reorder must show as a change');
});

test('reindentation is a change, since whitespace is part of the line', () => {
  const lines = diffLines('x\n', '  x\n');
  assert.deepEqual(render(lines), ['-x', '+  x']);
});

test('the LCS keeps the longest common run rather than the first match', () => {
  // The property that makes the output readable: a 1-line edit in the middle must not cascade into
  // "everything after it changed".
  const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
  const after = ['1', '2', 'THREE', '4', '5', '6', '7', '8'].join('\n');
  const lines = diffLines(before, after);
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
});

test('past MAX_DIFF_LINES it degrades to a whole-file replacement instead of stalling', () => {
  // The size guard. A quadratic table on a huge file would hang the dialog that exists to appear
  // BEFORE an irreversible write, which is the worst possible place to be slow.
  const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
  const alsoBig = `${big}\nextra`;
  const started = Date.now();
  const lines = diffLines(big, alsoBig);
  assert.ok(Date.now() - started < 2000, 'the guard must make this fast');
  const stats = diffStats(lines);
  assert.equal(stats.removed, MAX_DIFF_LINES + 1);
  assert.equal(stats.added, MAX_DIFF_LINES + 2);
  assert.equal(lines.filter((l) => l.kind === 'same').length, 0);
});

test('a diff just inside the guard is still a real diff', () => {
  // The companion to the test above: the guard must not be so eager that ordinary files lose their
  // real diff.
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[100] = 'changed';
  const result = diffLines(lines.join('\n'), changed.join('\n'));
  assert.deepEqual(diffStats(result), { added: 1, removed: 1 });
});

// ---------------------------------------------------------------------------------------------
// Clipping for display
// ---------------------------------------------------------------------------------------------

test('clipDiff keeps the change with context and elides the rest', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 20', 'CHANGED');
  const clipped = clipDiff(diffLines(before, after), 20);
  const text = render(clipped);

  assert.ok(text.includes('-line 20'), text.join('|'));
  assert.ok(text.includes('+CHANGED'), text.join('|'));
  // Context either side, and a marker for the 30-odd identical lines that were dropped.
  assert.ok(text.includes(' line 18'), 'two lines of context above');
  assert.ok(text.includes(' line 22'), 'two lines of context below');
  assert.ok(text.filter((l) => l.includes(ELISION)).length >= 1, 'elision marker expected');
  assert.ok(clipped.length <= 20);
});

test('clipDiff never returns more lines than asked, and marks the cut', () => {
  // A many-hunk diff: the tail is what gets dropped, because the first change is the one that
  // tells you whether the write is right.
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const after = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? `CHANGED ${i}` : `line ${i}`)).join('\n');
  for (const max of [1, 3, 8, 20]) {
    const clipped = clipDiff(diffLines(before, after), max);
    assert.ok(clipped.length <= max, `max ${max} produced ${clipped.length}`);
  }
  const eight = clipDiff(diffLines(before, after), 8);
  assert.equal(eight[eight.length - 1].text, ELISION, 'the cut is marked');
});

test('clipDiff on a small diff changes nothing', () => {
  const lines = diffLines('a\nold\nc\n', 'a\nnew\nc\n');
  assert.deepEqual(clipDiff(lines, 20), lines);
});

test('clipDiff with no room returns nothing rather than throwing', () => {
  assert.deepEqual(clipDiff(diffLines('a\n', 'b\n'), 0), []);
  assert.deepEqual(clipDiff([], 10), []);
});

test('formatDiffStats reads as a summary', () => {
  assert.equal(formatDiffStats({ added: 3, removed: 1 }), '+3 -1');
  assert.equal(formatDiffStats({ added: 3, removed: 0 }), '+3');
  assert.equal(formatDiffStats({ added: 0, removed: 2 }), '-2');
  assert.equal(formatDiffStats({ added: 0, removed: 0 }), 'no change');
});
