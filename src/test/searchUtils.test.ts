import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegExp, walkFiles } from '../tools/searchUtils.js';
import { grepTool } from '../tools/grep.js';

function matches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

test('* matches within a single path segment only', () => {
  assert.equal(matches('*.ts', 'foo.ts'), true);
  assert.equal(matches('*.ts', 'foo/bar.ts'), false);
});

test('**/ matches zero or more path segments, including zero', () => {
  assert.equal(matches('**/*.ts', 'foo.ts'), true);
  assert.equal(matches('**/*.ts', 'src/foo.ts'), true);
  assert.equal(matches('**/*.ts', 'src/deep/foo.ts'), true);
});

test('a literal prefix before ** still requires that prefix', () => {
  assert.equal(matches('src/**/*.ts', 'src/foo.ts'), true);
  assert.equal(matches('src/**/*.ts', 'src/a/b/foo.ts'), true);
  assert.equal(matches('src/**/*.ts', 'other/foo.ts'), false);
});

test('? matches exactly one character', () => {
  assert.equal(matches('foo?.ts', 'fooa.ts'), true);
  assert.equal(matches('foo?.ts', 'foo.ts'), false);
  assert.equal(matches('foo?.ts', 'fooab.ts'), false);
});

test('literal dots and other regex-special characters are escaped', () => {
  assert.equal(matches('a.b.ts', 'a.b.ts'), true);
  assert.equal(matches('a.b.ts', 'axbxts'), false);
});

test('bare ** without a trailing slash matches across segments too', () => {
  assert.equal(matches('foo**bar', 'foo/baz/bar'), true);
  assert.equal(matches('foo**bar', 'foobar'), true);
});

test('walkFiles lists directories alongside files, with no trailing slash on the path itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-walktest-'));
  try {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'top.txt'), 'hello');
    await writeFile(join(dir, 'sub', 'nested.txt'), 'world');

    const { entries } = await walkFiles(dir);
    const byPath = new Map(entries.map((e) => [e.path, e.isDirectory]));

    assert.equal(byPath.get('sub'), true);
    assert.equal(byPath.get('top.txt'), false);
    assert.equal(byPath.get('sub/nested.txt'), false);
    // No entry should carry a trailing slash - that's a display concern for callers, not the walk itself.
    assert.ok([...byPath.keys()].every((p) => !p.endsWith('/')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("glob pattern '*' matches a directory name (the ls use case)", () => {
  assert.equal(matches('*', 'sub'), true);
});

test('o4c\'s own .o4c state is never walked, and grep_files skips binary files (found live 2026-10-31)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-walktest-'));
  try {
    await mkdir(join(dir, '.o4c', 'db'), { recursive: true });
    await writeFile(join(dir, '.o4c', 'db', 'history.db'), 'farewellUser in a database page');
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x66, 0x61, 0x72, 0x00, 0x66, 0x61, 0x72, 0x65, 0x77, 0x65, 0x6c, 0x6c, 0x55, 0x73, 0x65, 0x72]));
    await writeFile(join(dir, 'greet.ts'), 'export function farewellUser() {}');

    const { entries } = await walkFiles(dir);
    assert.ok(!entries.some((e) => e.path.startsWith('.o4c')), 'nothing under .o4c');

    const out = await grepTool.execute({ pattern: 'farewellUser', path: dir });
    // Grouped under the definition the match is in (plan 0006 B13).
    assert.match(out, /^greet\.ts\n {2}farewellUser \(function, 1-1\):\n {4}1: export function farewellUser/);
    assert.doesNotMatch(out, /history\.db|blob\.bin/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('grep_files on a single file searches that file instead of answering "No matches" (tmp4 run)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-walktest-'));
  try {
    await writeFile(join(dir, 'ast.ts'), "export type C =\n  | { kind: 'NotNull' }\n");
    const out = await grepTool.execute({ pattern: 'NotNull', path: join(dir, 'ast.ts') });
    assert.equal(out, "ast.ts\n  C (type, 1-2):\n    2: | { kind: 'NotNull' }");
    assert.match(await grepTool.execute({ pattern: 'absent', path: join(dir, 'ast.ts') }), /^No matches/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
