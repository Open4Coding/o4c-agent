import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OS_KEYBOARD_NOTES, parseOsArg } from '../ui/osKeyboardNotes.js';

test('parseOsArg accepts known names/aliases case-insensitively, rejects garbage', () => {
  assert.equal(parseOsArg('windows'), 'windows');
  assert.equal(parseOsArg('Win'), 'windows');
  assert.equal(parseOsArg('MAC'), 'macos');
  assert.equal(parseOsArg('macos'), 'macos');
  assert.equal(parseOsArg('osx'), 'macos');
  assert.equal(parseOsArg('Darwin'), 'macos');
  assert.equal(parseOsArg('linux'), 'linux');
  assert.equal(parseOsArg('  linux  '), 'linux');
  assert.equal(parseOsArg('bogus'), undefined);
  assert.equal(parseOsArg(''), undefined);
});

test('OS_KEYBOARD_NOTES bullets are end-user text, not leaked dev citations', () => {
  const citationLike = [/\d+:\d+/, /#\d+/, /github\.com/i];
  for (const notes of Object.values(OS_KEYBOARD_NOTES)) {
    for (const bullet of [...notes.safe, ...notes.avoid, ...notes.notes]) {
      for (const pattern of citationLike) {
        assert.ok(
          !pattern.test(bullet),
          `bullet "${bullet}" looks like it contains a dev citation (matched ${pattern})`,
        );
      }
    }
  }
});
