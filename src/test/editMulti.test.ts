import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedRegion, editFileTool } from '../tools/editFile.js';

const dir = mkdtempSync(join(tmpdir(), 'o4c-editmulti-'));
let n = 0;
function file(content: string): string {
  const path = join(dir, `m${++n}.js`);
  writeFileSync(path, content);
  return path;
}

const SOURCE = ['import a from "a";', '', 'function one() {', '  return 1;', '}', '', 'function two() {', '  return 2;', '}', ''].join('\n');

test('several edits apply in order, each to the result of the one before', async () => {
  const path = file(SOURCE);
  const result = await editFileTool.execute({
    path,
    edits: [
      { old_string: 'return 1;', new_string: 'return 10;' },
      { old_string: 'function two() {\n  return 2;', new_string: 'function two() {\n  return one() * 2;' },
      { old_string: 'return 10;', new_string: 'return 11;' },
    ],
  });
  assert.match(result, /^Edited .*: 3 edits, 3 replacements\.\n/);
  assert.equal(readFileSync(path, 'utf-8'), SOURCE.replace('return 1;', 'return 11;').replace('return 2;', 'return one() * 2;'));
  // The changed region: first to last changed line, two lines of context, numbered.
  assert.equal(result.split('\n').slice(1).join('\n'), ['    2  ', '    3  function one() {', '    4    return 11;', '    5  }', '    6  ', '    7  function two() {', '    8    return one() * 2;', '    9  }'].join('\n'));
});

test('all or nothing: a failing edit leaves the file untouched and says which one', async () => {
  const path = file(SOURCE);
  const result = await editFileTool.execute({
    path,
    edits: [
      { old_string: 'return 1;', new_string: 'return 10;' },
      { old_string: 'return 3;', new_string: 'return 30;' },
    ],
  });
  assert.match(result, /edit 2 of 2: old_string was not found.*None of the edits were applied/s);
  assert.equal(readFileSync(path, 'utf-8'), SOURCE);
  assert.match(await editFileTool.execute({ path, edits: [] }), /pass old_string and new_string, or a non-empty edits list/);
});

test('a loose match is reported per edit', async () => {
  const path = file(SOURCE);
  const result = await editFileTool.execute({ path, edits: [{ old_string: 'return 1;', new_string: 'return 5;' }, { old_string: 'function two() {\nreturn 2;\n}', new_string: 'function two() {\nreturn 6;\n}' }] });
  assert.match(result, /2 edits, 2 replacements \(edit 2 matched ignoring indentation/);
  assert.match(readFileSync(path, 'utf-8'), /function two\(\) \{\n {2}return 6;\n\}/);
});

test('a long changed region keeps its start and end', () => {
  const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace(/line (\d+)/g, (m, d: string) => (Number(d) >= 10 && Number(d) < 80 ? `LINE ${d}` : m));
  const region = changedRegion(before, after).split('\n');
  assert.equal(region.length, 31);
  assert.equal(region[0], '    9  line 8');
  assert.match(region[20], /\.\.\. 44 more changed lines \.\.\./);
  assert.equal(region[30], '   82  line 81');
});
