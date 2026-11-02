import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { editFileTool } from '../tools/editFile.js';

/** edit_file - exact search and replace, refusing anything ambiguous (added after the tmp4 run). */

async function withFile(content: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-edit-test-'));
  const path = join(dir, 'a.ts');
  await writeFile(path, content);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('replaces a unique match and leaves the rest of the file alone', async () => {
  await withFile('const a = 1;\nconst b = 2;\n', async (path) => {
    assert.equal(await editFileTool.execute({ path, old_string: 'const b = 2;', new_string: 'const b = 3;' }), `Edited ${path}: replaced 1 occurrence.\n    1  const a = 1;\n    2  const b = 3;`);
    assert.equal(await readFile(path, 'utf-8'), 'const a = 1;\nconst b = 3;\n');
  });
});

test('refuses an ambiguous match unless replace_all is set', async () => {
  await withFile('x();\nx();\n', async (path) => {
    assert.match(await editFileTool.execute({ path, old_string: 'x();', new_string: 'y();' }), /occurs 2 times/);
    assert.equal(await readFile(path, 'utf-8'), 'x();\nx();\n', 'nothing written');
    assert.match(await editFileTool.execute({ path, old_string: 'x();', new_string: 'y();', replace_all: true }), /replaced 2 occurrences/);
    assert.equal(await readFile(path, 'utf-8'), 'y();\ny();\n');
  });
});

test('a missing match, an empty search and a no-op edit are errors, never writes', async () => {
  await withFile('abc\n', async (path) => {
    assert.match(await editFileTool.execute({ path, old_string: 'zzz', new_string: 'q' }), /was not found/);
    assert.match(await editFileTool.execute({ path, old_string: '', new_string: 'q' }), /old_string is empty/);
    assert.match(await editFileTool.execute({ path, old_string: 'abc', new_string: 'abc' }), /are the same/);
    assert.match(await editFileTool.execute({ path: path + '.missing', old_string: 'a', new_string: 'b' }), /^Error editing file/);
    assert.equal(await readFile(path, 'utf-8'), 'abc\n');
  });
});

test('dollar signs in the replacement are literal', async () => {
  await withFile('price\n', async (path) => {
    await editFileTool.execute({ path, old_string: 'price', new_string: "cost $& $1 $$" });
    assert.equal(await readFile(path, 'utf-8'), "cost $& $1 $$\n");
  });
});
