import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { Box, Text, render } from 'ink';
import { InputBox } from '../ui/InputBox.js';
import { expandedInputBoxCapRows, inputBoxCapRows } from '../ui/frameBudget.js';
import { VirtualTerminal } from './virtualTerminal.js';

/**
 * The stacked-input-box regression, checked against a modelled terminal rather than a string mock.
 *
 * `ink-testing-library`'s stdout has no rows, no scrolling and no wrapping, so it cannot see the
 * bug these tests are about: Ink erases the previous frame with `eraseLines(previousLineCount)`,
 * which counts `\n`-separated LINES, while the terminal spends ROWS. When a line is wider than the
 * terminal (a raw tab is the way this happened in practice - `string-width` scores one as zero
 * columns, so Ink never wraps the line) the erase moves up too few rows, the top of the previous
 * box is never erased, and every redraw leaves another copy on screen.
 *
 * `VirtualTerminal` replays the real byte stream Ink writes and reports the resulting screen, so
 * "does it stack?" becomes an assertion instead of a question only a real terminal could answer.
 */

const CSI = '\x1B[';
const ERASE_LINE = `${CSI}2K`;
const CURSOR_UP = `${CSI}1A`;
const CURSOR_LEFT = `${CSI}G`;
const BOX_TOP_LEFT = '╭'; // the round border's top-left corner: one per rendered input box

/** `ansiEscapes.eraseLines(n)`, byte for byte - what Ink prefixes every live frame with. */
function eraseLines(count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += ERASE_LINE + (i < count - 1 ? CURSOR_UP : '');
  return count > 0 ? out + CURSOR_LEFT : '';
}

// ---------------------------------------------------------------------------
// First: prove the oracle itself can see the bug. A model that passes everything
// is worse than no model at all, so these two tests pin that it reports stacking
// for a stream that genuinely stacks, and a clean screen for one that doesn't.
// ---------------------------------------------------------------------------

/** Two repaints of a 3-line bordered frame whose middle line is `middle`, the way Ink writes them. */
function repaintTwice(middle: string, columns: number, rows: number): VirtualTerminal {
  const term = new VirtualTerminal({ columns, rows });
  const frame = [
    '╭' + '─'.repeat(columns - 2) + '╮',
    middle,
    '╰' + '─'.repeat(columns - 2) + '╯',
  ].join('\n');
  term.write(frame + '\n');
  // Ink's own `previousLineCount` is the frame's line count plus one for the trailing newline - it
  // has no idea whether any of those lines wrapped.
  term.write(eraseLines(4) + frame + '\n');
  return term;
}

test('oracle: a frame line that fits leaves exactly one box on screen', () => {
  const term = repaintTwice('│ short line                 │', 60, 30);
  assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 1, 'the erase must remove the previous box entirely');
});

test('oracle: a tab-widened frame line leaves a stale copy, and the oracle reports it', () => {
  // Ten tabs reach column 80 before any text, so this line needs two rows at 60 columns while Ink
  // counts it as one. This is the real mechanism behind the reported artifacts, reproduced end to
  // end: if this test ever starts passing with a count of 1, the oracle has stopped being able to
  // see the bug and the regression test below is worthless.
  const term = repaintTwice('│' + '\t'.repeat(10) + 'text │', 60, 30);
  assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 2, 'the under-counted erase must leave the old box behind');
});

// ---------------------------------------------------------------------------
// Then: the regression itself, driven through real Ink.
// ---------------------------------------------------------------------------

class FakeTty extends EventEmitter {
  isTTY = true;
  chunks: string[] = [];
  constructor(public columns: number, public rows: number) {
    super();
  }
  write(chunk: unknown): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    const d = this.data;
    this.data = null;
    return d;
  }
  write(d: string): void {
    this.data = d;
    this.emit('readable');
    this.emit('data', d);
  }
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Renders a real `InputBox` into a modelled terminal, types `text`, then presses up-arrow
 * `moves` times - the exact sequence that produced David's screenshots - and returns the screen.
 */
async function drive(
  text: string,
  { columns = 100, rows = 30, moves = 5, expand = false } = {},
): Promise<VirtualTerminal> {
  const stdout = new FakeTty(columns, rows);
  const stdin = new FakeStdin();
  const { unmount } = render(React.createElement(InputBox, { onSubmit: () => {} }), {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeTty(columns, rows) as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();
  stdin.write(text);
  await settle();
  if (expand) {
    stdin.write(String.fromCharCode(15)); // Ctrl+O
    await settle();
  }
  for (let i = 0; i < moves; i++) {
    stdin.write(`${CSI}A`); // up-arrow: moves the cursor within the text, repainting each time
    await settle(60);
  }
  await settle();
  unmount();
  const term = new VirtualTerminal({ columns, rows });
  for (const chunk of stdout.chunks) term.write(chunk);
  return term;
}

test('a tab-indented paste leaves exactly one input box after repeated cursor movement', async () => {
  // Four lines, under PASTE_COLLAPSE_LINES, so the box renders the text instead of collapsing it to
  // a placeholder - which is the case that actually exercises the frame geometry.
  const term = await drive('\tfirst line of pasted code\n\t\tsecond line indented further\n\tthird line\n\t\t\tfourth');
  assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 1, 'cursor movement must not stack copies of the box');
});

test('a space-indented paste behaves identically to a tab-indented one', async () => {
  const term = await drive('    first line of pasted code\n        second line indented further\n    third line\n            fourth');
  assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 1, 'the space-indented case was always clean and must stay so');
});

test('no rendered frame line is wider than the terminal', async () => {
  const term = await drive('\tindented\n\t\tfurther\n\tback', { columns: 60 });
  for (const line of term.screen()) {
    assert.ok(
      line.length <= 60,
      `a frame line of ${line.length} columns outgrows the 60-column terminal: ${JSON.stringify(line)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The bounded box: a value far taller than the terminal must still draw one box
// that fits. Text under PASTE_COLLAPSE_LINES is used deliberately - a longer
// paste collapses to a placeholder and never exercises the geometry at all.
// ---------------------------------------------------------------------------

/** Five logical lines of `chars` characters each: wraps into far more rows than any budget allows. */
function tallValue(chars: number): string {
  return Array.from({ length: 5 }, (_, i) => `${i} ` + 'word '.repeat(Math.ceil(chars / 5))).join('\n');
}

for (const rows of [30, 60, 114]) {
  test(`a value taller than the box leaves exactly one box, and it fits, at ${rows} rows`, async () => {
    const term = await drive(tallValue(400), { columns: 100, rows, moves: 6 });
    assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 1, 'cursor movement must not stack copies');
    const screen = term.screen();
    assert.ok(screen.length < rows, `the frame used ${screen.length} of ${rows} rows, leaving no spare`);
    const cap = inputBoxCapRows(rows);
    const top = screen.findIndex((l) => l.includes(BOX_TOP_LEFT));
    const bottom = screen.findIndex((l) => l.includes('╰'));
    assert.ok(top >= 0 && bottom > top, 'the box must be drawn with both borders');
    // Content rows between the borders: at most the budget plus the two "hidden" notices.
    assert.ok(
      bottom - top - 1 <= cap + 2,
      `the box drew ${bottom - top - 1} content rows, over the ${cap}-row budget (+2 notices)`,
    );
  });
}

test('a narrow terminal re-wraps into more rows without breaking the bound', async () => {
  // The same text at 40 columns occupies roughly 2.5x the rows it did at 100 - the case a budget
  // computed only from the terminal HEIGHT would miss entirely.
  const term = await drive(tallValue(400), { columns: 40, rows: 30, moves: 6 });
  assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 1, 'narrow wrapping must not stack copies');
  assert.ok(term.screen().length < 30, 'the frame must still fit the viewport when wrapping is heavy');
  for (const line of term.screen()) {
    assert.ok(line.length <= 40, `a frame line of ${line.length} columns outgrows the 40-column terminal`);
  }
});

test('the hidden-text notices track where the cursor is, and appear only when text is cut off', async () => {
  // Straight after a paste the cursor sits at the END of the value, so the window shows the tail
  // and what is cut off is above it.
  const atEnd = await drive(tallValue(400), { columns: 100, rows: 30, moves: 0 });
  assert.ok(
    atEnd.screen().some((l) => l.includes('more above')),
    'with the cursor at the end, the rows above it must be announced',
  );
  // Walking the cursor up far enough brings rows below the window into play.
  const movedUp = await drive(tallValue(400), { columns: 100, rows: 30, moves: 10 });
  assert.ok(
    movedUp.screen().some((l) => l.includes('more below')),
    'once the cursor moves up, the rows below it must be announced',
  );
  const short = await drive('one line', { columns: 100, rows: 30, moves: 0 });
  assert.ok(
    !short.screen().some((l) => l.includes('more above') || l.includes('more below')),
    'a value that fits must show no notice',
  );
});

// ---------------------------------------------------------------------------
// Ctrl+O expansion: the box grows to 80% of the screen and the whole paste
// becomes editable. This is the case that was abandoned on 2026-10-05 because
// it stacked a copy of the box on every cursor move.
// ---------------------------------------------------------------------------

/** Eight long lines: over PASTE_COLLAPSE_LINES, so it collapses and Ctrl+O has something to expand. */
function collapsiblePaste(): string {
  return Array.from({ length: 8 }, (_, i) => `line ${i} ` + 'word '.repeat(30)).join('\n');
}

/** Rows between the box's two border lines on screen. */
function boxHeight(term: VirtualTerminal): number {
  const screen = term.screen();
  return screen.findIndex((l) => l.includes('╰')) - screen.findIndex((l) => l.includes(BOX_TOP_LEFT));
}

for (const rows of [30, 60, 114]) {
  test(`an expanded paste leaves exactly one box, and it fits, at ${rows} rows`, async () => {
    const term = await drive(collapsiblePaste(), { columns: 100, rows, moves: 8, expand: true });
    assert.equal(term.countRowsContaining(BOX_TOP_LEFT), 1, 'expanding then scrolling must not stack copies');
    const screen = term.screen();
    assert.ok(screen.length < rows, `the expanded frame used ${screen.length} of ${rows} rows`);
    const cap = expandedInputBoxCapRows(rows);
    assert.ok(boxHeight(term) > 0, 'the expanded box must be drawn with both borders');
    assert.ok(
      boxHeight(term) - 1 <= cap + 2,
      `the expanded box drew ${boxHeight(term) - 1} content rows, over the ${cap}-row budget (+2 notices)`,
    );
  });
}

test('an expanded box is taller than a collapsed one but still fits', async () => {
  const collapsed = await drive(collapsiblePaste(), { columns: 100, rows: 114, moves: 0, expand: false });
  const expanded = await drive(collapsiblePaste(), { columns: 100, rows: 114, moves: 0, expand: true });
  assert.ok(boxHeight(expanded) > boxHeight(collapsed), 'ctrl-O must actually grow the box');
  assert.ok(expanded.screen().length < 114, 'and the grown frame must still fit the viewport');
});
