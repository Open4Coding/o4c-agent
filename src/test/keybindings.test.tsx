import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox, resetPasteStoreForTests } from '../ui/InputBox.js';
import { describeKeybindings, isAction, keyLabel, resolveKeybindings, setKeybindingsForTests } from '../ui/keybindings.js';

beforeEach(resetPasteStoreForTests);
afterEach(() => setKeybindingsForTests(undefined));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('no file means the defaults, with no errors', () => {
  const kb = resolveKeybindings(undefined);
  assert.equal(kb.keys['history-search'], 'r');
  assert.equal(kb.keys.editor, 'g');
  assert.deepEqual(kb.errors, []);
});

test('a valid remap applies; a swap of two actions is allowed', () => {
  const kb = resolveKeybindings({ editor: 'ctrl+e', 'line-end': 'CTRL+G' });
  assert.equal(kb.keys.editor, 'e');
  assert.equal(kb.keys['line-end'], 'g');
  assert.deepEqual(kb.errors, []);
});

test('bad entries are refused by name and keep their defaults', () => {
  const kb = resolveKeybindings({ editor: 'ctrl+c', queue: 'alt+q', bogus: 'ctrl+x', 'kill-line': 'ctrl+m' });
  assert.equal(kb.keys.editor, 'g');
  assert.equal(kb.keys.queue, 'q');
  assert.equal(kb.keys['kill-line'], 'u');
  assert.equal(kb.errors.length, 4);
  assert.match(kb.errors.join('\n'), /Unknown action "bogus"/);
  assert.match(kb.errors.join('\n'), /ctrl\+c is reserved/);
});

test('two actions on one key is a conflict, and both keep their defaults', () => {
  const kb = resolveKeybindings({ editor: 'ctrl+r' });
  assert.equal(kb.keys.editor, 'g');
  assert.equal(kb.keys['history-search'], 'r');
  assert.match(kb.errors.join('\n'), /ctrl\+r is bound to/);
  assert.match(resolveKeybindings([]).errors[0]!, /must be an object/);
});

test('isAction, keyLabel and the /keyboard-bindings listing follow the bindings', () => {
  setKeybindingsForTests(resolveKeybindings({ editor: 'ctrl+e', 'line-end': 'ctrl+g' }));
  assert.equal(isAction('editor', 'e', { ctrl: true }), true);
  assert.equal(isAction('editor', 'g', { ctrl: true }), false);
  assert.equal(isAction('editor', 'e', { ctrl: false }), false);
  assert.equal(keyLabel('line-end'), 'Ctrl+G');
  const listing = describeKeybindings().join('\n');
  assert.match(listing, /Ctrl\+E\s+editor\s+Compose the message in your editor \(default Ctrl\+G\)/);
});

test('a remapped key drives the input box: kill-line moved to Ctrl+Y', async () => {
  setKeybindingsForTests(resolveKeybindings({ 'kill-line': 'ctrl+y' }));
  const submitted: string[] = [];
  const { stdin } = render(React.createElement(InputBox, { onSubmit: (v: string) => submitted.push(v) }));
  await tick();
  for (const ch of 'abc') {
    stdin.write(ch);
    await tick(5);
  }
  stdin.write(String.fromCharCode(21)); // Ctrl+U: no longer bound
  await tick();
  stdin.write(String.fromCharCode(25)); // Ctrl+Y: kill to the cursor
  await tick();
  stdin.write('z');
  await tick();
  stdin.write('\r');
  await tick(60);
  assert.deepEqual(submitted, ['z']);
});
