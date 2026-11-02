import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool } from '../tools/editFile.js';
import { closestLines, findEdit } from '../tools/editMatch.js';

const dir = mkdtempSync(join(tmpdir(), 'o4c-editmatch-'));
let n = 0;
async function edit(content: string, old_string: string, new_string: string, replace_all = false): Promise<{ result: string; after: string }> {
  const path = join(dir, `f${++n}.txt`);
  writeFileSync(path, content);
  const result = await editFileTool.execute({ path, old_string, new_string, replace_all });
  return { result, after: readFileSync(path, 'utf-8') };
}

test('a CRLF file edited with LF text succeeds and stays CRLF throughout', async () => {
  const { result, after } = await edit('a\r\nfunction f() {\r\n  return 1;\r\n}\r\nz\r\n', 'function f() {\n  return 1;\n}', 'function f() {\n  return 2;\n}');
  assert.match(result, /replaced 1 occurrence \(matched ignoring line endings\)/);
  assert.equal(after, 'a\r\nfunction f() {\r\n  return 2;\r\n}\r\nz\r\n');
});

test('an exact match in a CRLF file writes new lines as CRLF too', async () => {
  const { after } = await edit('x = 1\r\ny = 2\r\n', 'y = 2', 'y = 2\nw = 3');
  assert.equal(after, 'x = 1\r\ny = 2\r\nw = 3\r\n');
});

test('trailing whitespace differences are tolerated', async () => {
  const { result, after } = await edit('if (a) {   \n  go();\t\n}\n', 'if (a) {\n  go();\n}', 'if (a) {\n  stop();\n}');
  assert.match(result, /ignoring trailing whitespace/);
  assert.equal(after, 'if (a) {\n  stop();\n}\n');
});

test('indentation differences are tolerated and new_string is re-indented to the file', async () => {
  const file = 'class A {\n    run() {\n        work();\n    }\n}\n';
  const { result, after } = await edit(file, 'run() {\n    work();\n}', 'run() {\n    work();\n    more();\n}');
  assert.match(result, /ignoring indentation/);
  assert.equal(after, 'class A {\n    run() {\n        work();\n        more();\n    }\n}\n');
});

test('an ambiguous loose match is refused, and replace_all takes them all', async () => {
  const file = 'def a():\n    x = 1\n\nclass B:\n        x = 1\n';
  const { result, after } = await edit(file, 'x = 1', 'x = 2');
  assert.match(result, /occurs 2 times/);
  assert.equal(after, file);
  const loose = await edit('  a()\n    b()\n\n      a()\n  b()\n', 'a()\nb()', 'c()');
  assert.match(loose.result, /occurs 2 times \(matched ignoring indentation/);
  const all = await edit(file, 'x = 1', 'x = 2', true);
  assert.equal(all.after, 'def a():\n    x = 2\n\nclass B:\n        x = 2\n');
});

test('over-escaped text (literal \\n and \\") is unescaped as a last resort', async () => {
  const { result, after } = await edit('say("hi")\nend\n', 'say(\\"hi\\")\\nend', 'say(\\"bye\\")\\nend');
  assert.match(result, /after unescaping/);
  assert.equal(after, 'say("bye")\nend\n');
});

test('a miss shows the closest lines, numbered', async () => {
  const file = 'one\ntwo\nconst total = items.reduce((a, b) => a + b, 0);\nthree\n';
  const { result, after } = await edit(file, 'const total = items.reduce((sum, b) => sum + b);', 'x');
  assert.match(result, /not found.*closest lines in the file are:\n {4}1 {2}one\n {4}2 {2}two\n {4}3 {2}const total = items\.reduce.*\n {4}4 {2}three\nCopy the exact/s);
  assert.equal(after, file);
  assert.equal(closestLines(file, 'nothing like it'), undefined);
});

test('$ sequences in new_string are literal, and exact still wins over looser rungs', async () => {
  const { after } = await edit('price = 1\n', 'price = 1', "price = '$&$1'");
  assert.equal(after, "price = '$&$1'\n");
  assert.equal(findEdit('  a\na\n', 'a', 'b')?.rung, 'exact');
});
