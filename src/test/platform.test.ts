import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCurrentOs, platformPromptLine, shellFor } from '../ui/platform.js';

test('detectCurrentOs maps win32/darwin/everything-else to windows/macos/linux', () => {
  assert.equal(detectCurrentOs('win32'), 'windows');
  assert.equal(detectCurrentOs('darwin'), 'macos');
  assert.equal(detectCurrentOs('linux'), 'linux');
  // Unlisted platforms (e.g. freebsd) fall back to 'linux', the Unix-baseline bucket - explicit,
  // not accidental.
  assert.equal(detectCurrentOs('freebsd'), 'linux');
});

test('shellFor uses ComSpec on Windows and /bin/sh elsewhere', () => {
  assert.equal(shellFor('windows', { ComSpec: 'C:\Windows\system32\cmd.exe' }), 'C:\Windows\system32\cmd.exe');
  assert.equal(shellFor('windows', {}), 'cmd.exe');
  assert.equal(shellFor('linux', { ComSpec: 'ignored' }), '/bin/sh');
  assert.equal(shellFor('macos', {}), '/bin/sh');
});

test('platformPromptLine names the real OS and shell, and warns off Unix commands on Windows', () => {
  const windows = platformPromptLine('windows', { ComSpec: 'C:\Windows\system32\cmd.exe' });
  assert.match(windows, /Platform: Windows/);
  assert.match(windows, /cmd\.exe/);
  assert.match(windows, /Do not assume Unix commands/);
  assert.match(platformPromptLine('macos', {}), /^Platform: macOS\. Shell commands run in \/bin\/sh\.$/);
  assert.match(platformPromptLine('linux', {}), /^Platform: Linux\./);
});
