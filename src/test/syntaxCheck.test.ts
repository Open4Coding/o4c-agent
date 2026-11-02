import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSyntaxProblems, setSyntaxCheckMode, syntaxProblems } from '../tools/syntaxCheck.js';
import { editFileTool } from '../tools/editFile.js';
import { writeFileTool } from '../tools/writeFile.js';

const dir = mkdtempSync(join(tmpdir(), 'o4c-syntax-'));
const GOOD = 'function a(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\n\nexport const b = 3;\n';

test('problems are found with line numbers; unknown file types are not checked', async () => {
  assert.deepEqual(await syntaxProblems('a.js', GOOD), []);
  const broken = await syntaxProblems('a.js', GOOD.replace('  }\n  return 2;', '  return 2;'));
  assert.ok(broken && broken.length > 0);
  assert.equal(await syntaxProblems('notes.txt', '{{{'), undefined);
  const py = await syntaxProblems('a.py', 'def f(:\n    return 1\n');
  assert.ok(py && py.length > 0 && py[0]!.line === 1);
});

test('only problems the edit introduced are reported', async () => {
  assert.equal(await newSyntaxProblems('a.js', GOOD, GOOD.replace('return 1', 'return 10')), undefined);
  const already = 'function a( {\n';
  assert.equal(await newSyntaxProblems('a.js', already, `${already}const x = 1;\n`), undefined);
  assert.match((await newSyntaxProblems('a.js', '', 'const = ;\n'))!, /does not parse as javascript: line 1/);
});

test('an edit that unbalances braces is written but reported with its line; strict mode refuses it', async () => {
  const path = join(dir, 'a.js');
  writeFileSync(path, GOOD);
  const result = await editFileTool.execute({ path, old_string: '    return 1;\n  }\n', new_string: '    return 1;\n' });
  assert.match(result, /Warning: the result does not parse as javascript: line \d+/);
  assert.notEqual(readFileSync(path, 'utf-8'), GOOD);

  writeFileSync(path, GOOD);
  setSyntaxCheckMode('strict');
  try {
    const refused = await editFileTool.execute({ path, old_string: '    return 1;\n  }\n', new_string: '    return 1;\n' });
    assert.match(refused, /^Error editing file .*does not parse.*Nothing was changed \(syntax check is strict\)/);
    assert.equal(readFileSync(path, 'utf-8'), GOOD);
    const w = await writeFileTool.execute({ path: join(dir, 'b.py'), content: 'def f(:\n' });
    assert.match(w, /Nothing was written \(syntax check is strict\)/);
  } finally {
    setSyntaxCheckMode('warn');
  }

  setSyntaxCheckMode('off');
  try {
    assert.doesNotMatch(await writeFileTool.execute({ path: join(dir, 'c.js'), content: 'const = ;\n' }), /Warning/);
  } finally {
    setSyntaxCheckMode('warn');
  }
  assert.doesNotMatch(await writeFileTool.execute({ path: join(dir, 'd.js'), content: GOOD }), /Warning/);
});
