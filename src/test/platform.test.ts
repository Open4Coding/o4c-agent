import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCurrentOs } from '../ui/platform.js';

test('detectCurrentOs maps win32/darwin/everything-else to windows/macos/linux', () => {
  assert.equal(detectCurrentOs('win32'), 'windows');
  assert.equal(detectCurrentOs('darwin'), 'macos');
  assert.equal(detectCurrentOs('linux'), 'linux');
  // Unlisted platforms (e.g. freebsd) fall back to 'linux', the Unix-baseline bucket - explicit,
  // not accidental.
  assert.equal(detectCurrentOs('freebsd'), 'linux');
});
