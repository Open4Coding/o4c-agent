import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../ui/InputBox.js';

// Standard terminal escape/control sequences Ink's useInput parses into named keys. Built via
// String.fromCharCode rather than string-literal escapes so the exact bytes sent are unambiguous.
const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const BACKSPACE = String.fromCharCode(127);
const UP = ESC + '[A';
const DOWN = ESC + '[B';
const LEFT = ESC + '[D';
const RIGHT = ESC + '[C';
const CTRL_A = String.fromCharCode(1);
const CTRL_E = String.fromCharCode(5);
const CTRL_U = String.fromCharCode(21);

// Ink's useInput subscribes to input inside a useEffect, which runs asynchronously after
// render() returns (and after each state-driven re-render) - not synchronously with it. Every
// write needs to happen after that effect has actually flushed, or the keystroke is dropped
// with no error at all (this is what caused every assertion here to see zero onSubmit calls
// on the first attempt at this test file).
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function type(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

async function press(stdin: { write: (data: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  await tick();
}

test('typing then pressing Enter submits the typed value and clears the box', async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }),
  );
  await tick();

  await type(stdin, 'hello world');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['hello world']);
  assert.equal(lastFrame()?.includes('hello world'), false);
});

test('submitting an empty box calls onSubmit with an empty string (caller decides whether to ignore it)', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['']);
});

test('backspace deletes the character before the cursor', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'abc');
  await press(stdin, BACKSPACE);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['ab']);
});

test('left/right arrows move the cursor so backspace and typing act at the right position', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'ac');
  await press(stdin, LEFT);
  await type(stdin, 'b');
  await press(stdin, RIGHT);
  await type(stdin, 'd');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['abcd']);
});

test('up/down arrow history recall cycles through previously submitted values', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'first');
  await press(stdin, ENTER);
  await type(stdin, 'second');
  await press(stdin, ENTER);

  await press(stdin, UP);
  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['first', 'second', 'first']);
});

test('down arrow past the newest history entry restores the in-progress draft, not empty', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'submitted once');
  await press(stdin, ENTER);

  await type(stdin, 'draft in progress');
  await press(stdin, UP);
  await press(stdin, DOWN);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['submitted once', 'draft in progress']);
});

test('Ctrl+A/E jump to the start/end of the buffer, Ctrl+U clears it entirely', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello');
  await press(stdin, CTRL_A);
  await type(stdin, 'X');
  await press(stdin, CTRL_E);
  await type(stdin, 'Y');
  await press(stdin, CTRL_U);
  await type(stdin, 'clean');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['clean']);
});

test('Ctrl+U only kills from line-start to the cursor, leaving text after it in place', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello world');
  for (let i = 0; i < 6; i++) await press(stdin, LEFT); // cursor between "hello" and " world"
  await press(stdin, CTRL_U);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, [' world']);
});

test('up-arrow right after Ctrl+U yanks the killed text back in at the cursor', async () => {
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'hello world');
  for (let i = 0; i < 6; i++) await press(stdin, LEFT); // cursor between "hello" and " world"
  await press(stdin, CTRL_U);
  await press(stdin, UP);
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['hello world']);
});

test('a second up-arrow after the yank is consumed falls through to normal history recall', async () => {
  // Checks the final submitted value only, not an intermediate lastFrame() snapshot - Ink's
  // reconciliation across two rapid state-updating keystrokes (Ctrl+U then Up) can be caught
  // mid-repaint by a frame snapshot one tick in, even though the underlying state is already
  // correct (confirmed by tracing it directly). If the kill ring wrongly yanked a *second* time
  // instead of falling through to history, the final value would be 'betabeta' or similar, not
  // a clean 'alpha' - so this still fully exercises the fallthrough without relying on a frame
  // captured at a fragile instant.
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'alpha');
  await press(stdin, ENTER);

  await type(stdin, 'beta');
  await press(stdin, CTRL_U); // cursor is at the end, kills the whole word
  await press(stdin, UP); // first up-arrow: yanks 'beta' back
  await press(stdin, UP); // kill ring is now empty: falls through to real history recall
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['alpha', 'alpha']);
});

test('the kill ring is cleared on submit, so it does not bleed into the next message', async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(React.createElement(InputBox, { onSubmit: (v) => submitted.push(v) }));
  await tick();

  await type(stdin, 'killed text');
  await press(stdin, CTRL_U);
  await press(stdin, ENTER); // submits '', and should clear the kill ring too

  await type(stdin, 'fresh');
  await press(stdin, UP); // no history yet and no kill ring - must be a no-op, not a stale yank

  assert.equal(lastFrame()?.includes('killed text'), false);
  await press(stdin, ENTER);
  assert.deepEqual(submitted, ['', 'fresh']);
});

test('editing works even when disabled=true, matching the type-ahead queueing design', async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    React.createElement(InputBox, { disabled: true, onSubmit: (v) => submitted.push(v) }),
  );
  await tick();

  await type(stdin, 'queued message');
  await press(stdin, ENTER);

  assert.deepEqual(submitted, ['queued message']);
});
