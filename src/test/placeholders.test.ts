import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPlaceholder } from '../tools/placeholders.js';
import { writeFileTool } from '../tools/writeFile.js';
import { editFileTool } from '../tools/editFile.js';

test('placeholder lines in the forms models write are found', () => {
  for (const line of [
    '// ... rest of the code',
    '    // ...',
    '# ... existing imports',
    '/* ... */',
    '// rest of the file unchanged',
    '# existing code here',
    '<!-- remaining markup as before -->',
    '  // ... (unchanged)',
    '# code omitted for brevity',
    '(rest of file unchanged)',
    '[... existing code ...]',
    '-- other functions remain the same',
  ]) {
    assert.equal(findPlaceholder(`a\n${line}\nb`), line.trim(), line);
  }
});

test('ordinary code and comments are not placeholders', () => {
  for (const text of [
    'const all = [...rest, ...more];',
    'def f():\n    ...',
    'function f(...args) {}',
    '// Handles the rest of the request after auth.',
    '# Keep existing behaviour for old clients',
    'print("... loading")',
    '// TODO: more tests',
  ]) {
    assert.equal(findPlaceholder(text), undefined, text);
  }
});

test('a placeholder the replaced text already had is allowed', () => {
  assert.equal(findPlaceholder('x\n// ... rest of the code\n', 'y\n  // ... rest of the code'), undefined);
});

test('write_file and edit_file refuse new text with a placeholder and change nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-placeholder-'));
  const path = join(dir, 'a.js');
  const original = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
  writeFileSync(path, original);
  const w = await writeFileTool.execute({ path, content: 'function a() {\n  return 10;\n}\n\n// ... rest of the file unchanged\n' });
  assert.match(w, /looks like a placeholder for code left out.*Nothing was written/);
  const e = await editFileTool.execute({ path, old_string: 'function a() {\n  return 1;\n}', new_string: 'function a() {\n  // ... existing code\n  return 10;\n}' });
  assert.match(e, /new_string contains "\/\/ \.\.\. existing code".*Nothing was changed/);
  assert.equal(readFileSync(path, 'utf-8'), original);
  assert.match(await writeFileTool.execute({ path, content: 'const x = [...a];\n' }), /^Overwrote/);
});
