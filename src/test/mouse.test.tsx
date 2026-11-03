import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox, resetPasteStoreForTests } from '../ui/InputBox.js';
import { cursorAtVisualRow, cursorInVisualRows } from '../ui/inputBoxLayout.js';
import { isLeftClick, parseCursorReport, parseSgrMouse, tapStdin } from '../ui/mouse.js';

beforeEach(resetPasteStoreForTests);

const ESC = String.fromCharCode(27);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('parseSgrMouse reads presses and releases; only a plain left press is a click', () => {
  const events = parseSgrMouse(`${ESC}[<0;10;5M${ESC}[<0;10;5m${ESC}[<64;3;3M`);
  assert.deepEqual(events, [
    { button: 0, x: 10, y: 5, press: true },
    { button: 0, x: 10, y: 5, press: false },
    { button: 64, x: 3, y: 3, press: true },
  ]);
  assert.deepEqual(events.map(isLeftClick), [true, false, false]);
});

test('parseCursorReport reads the row and column', () => {
  assert.deepEqual(parseCursorReport(`${ESC}[12;40R`), { row: 12, col: 40 });
  assert.equal(parseCursorReport('12;40R'), undefined);
});

test('tapStdin sees each chunk, passes it through unchanged, and untaps cleanly', () => {
  const queue = ['abc', null];
  const fake = { read: () => queue.shift() ?? null } as unknown as NodeJS.ReadStream;
  const original = (fake as unknown as { read: unknown }).read;
  const seen: string[] = [];
  const untap = tapStdin(fake, (c) => {
    seen.push(c);
    throw new Error('a failing tap must not break input');
  });
  assert.equal((fake as unknown as { read: () => unknown }).read(), 'abc');
  assert.equal((fake as unknown as { read: () => unknown }).read(), null);
  assert.deepEqual(seen, ['abc']);
  untap();
  assert.equal((fake as unknown as { read: unknown }).read, original);
});

test('cursorAtVisualRow inverts cursorInVisualRows for every position of a wrapped, multi-line value', () => {
  const value = 'the quick brown fox jumps over the lazy dog\nshort\n\nand a final line that wraps around too';
  for (const width of [12, 20, 80]) {
    for (let cursor = 0; cursor <= value.length; cursor++) {
      const { row, col } = cursorInVisualRows(value, cursor, width, '> ');
      assert.equal(cursorAtVisualRow(value, width, '> ', row, col), cursor, `width ${width}, cursor ${cursor}`);
    }
  }
  assert.equal(cursorAtVisualRow('abc', 80, '> ', 99, 99), 3, 'clamped past the end');
});

test('a click in the box moves the cursor there, measured from the caret the terminal reports', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v: string) => submitted.push(v), mouse: true }));
  await tick();
  for (const ch of 'hello world') {
    stdin.write(ch);
    await tick(5);
  }
  await tick();
  // Caret after "> hello world" sits at column 13 of the box's row; say the terminal puts it at
  // screen row 5, column 14. A click at column 7 is 7 columns left of it: text column 4.
  stdin.write(`${ESC}[<0;7;5M`);
  await tick();
  stdin.write(`${ESC}[5;14R`);
  await tick();
  stdin.write('X');
  await tick();
  stdin.write('\r');
  await tick(60);
  assert.deepEqual(submitted, ['hellXo world']);
});

test('a click outside the box rows is ignored', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v: string) => submitted.push(v), mouse: true }));
  await tick();
  for (const ch of 'abc') {
    stdin.write(ch);
    await tick(5);
  }
  stdin.write(`${ESC}[<0;3;2M`);
  await tick();
  stdin.write(`${ESC}[5;6R`);
  await tick();
  stdin.write('X');
  await tick();
  stdin.write('\r');
  await tick(60);
  assert.deepEqual(submitted, ['abcX']);
});
