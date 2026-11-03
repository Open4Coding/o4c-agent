import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editorCommand, editText, isTerminalEditor } from '../ui/externalEditor.js';

test('editorCommand prefers VISUAL, then EDITOR, then the platform default', () => {
  assert.equal(editorCommand({ VISUAL: 'code --wait', EDITOR: 'vim' }, 'linux'), 'code --wait');
  assert.equal(editorCommand({ EDITOR: 'nano' }, 'linux'), 'nano');
  assert.equal(editorCommand({}, 'win32'), 'notepad');
  assert.equal(editorCommand({}, 'darwin'), 'vi');
});

test('isTerminalEditor knows terminal editors from GUI ones', () => {
  assert.equal(isTerminalEditor('vim'), true);
  assert.equal(isTerminalEditor('/usr/bin/nvim -u NONE'), true);
  assert.equal(isTerminalEditor('nano.exe'), true);
  assert.equal(isTerminalEditor('code --wait'), false);
  assert.equal(isTerminalEditor('notepad'), false);
});

test('editText round-trips the text through the editor and trims trailing newlines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-editor-test-'));
  try {
    const script = join(dir, 'fake-editor.mjs');
    writeFileSync(script, "import fs from 'node:fs'; const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + ' edited' + String.fromCharCode(10, 10));");
    const r = editText('draft', { EDITOR: `node "${script}"` });
    assert.equal(r.error, undefined);
    assert.equal(r.text, 'draft edited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editText reports an editor that fails', () => {
  const r = editText('draft', { EDITOR: 'node -e "process.exit(3)"' });
  assert.equal(r.text, undefined);
  assert.match(r.error ?? '', /exited with 3/);
});
