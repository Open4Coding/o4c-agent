import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { indexSource } from '../graph/indexer.js';
import { CodeGraphComponent } from '../graph/toolHook.js';
import { reviewPrompt } from '../session/review.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 D9: a changed signature points at its call sites; /review's prompt. */

const LIB = 'export function area(r: number): number {\n  return r * r;\n}\n';
const USE = "import { area } from './lib';\nexport const a = area(2);\nexport const b = area(3);\n";

test('an edit that changes a signature lists the call sites; one that does not, says nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o4c-sig-'));
  await writeFile(join(root, 'lib.ts'), LIB);
  await writeFile(join(root, 'use.ts'), USE);
  const store = new GraphStore(join(root, '.o4c', GRAPH_DB_FILENAME));
  try {
    await indexSource(store, 'lib.ts', LIB);
    await indexSource(store, 'use.ts', USE);
    const component = new CodeGraphComponent(store, root);
    const edit: Tool = { name: 'edit_file', description: '', inputSchema: {}, mutating: true, execute: async () => '' };
    const run = async (content: string) =>
      component.aroundTool({ tool: edit, input: { path: join(root, 'lib.ts') } }, async () => {
        await writeFile(join(root, 'lib.ts'), content);
        return 'Edited lib.ts: replaced 1 occurrence.';
      });

    const same = await run('export function area(r: number): number {\n  return r * r * 1;\n}\n');
    assert.equal(same, 'Edited lib.ts: replaced 1 occurrence.');
    const changed = await run('export function area(r: number, unit: string): number {\n  return r * r;\n}\n');
    assert.match(changed, /\n\[code graph\] area changed from `function area\(r: number\): number` to `function area\(r: number, unit: string\): number` - 2 call site\(s\) may need updating: use\.ts:2, use\.ts:3$/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('/review asks for a read-only review of the diff, or to look with git when there is none', () => {
  const withDiff = reviewPrompt('diff --git a/x b/x\n+new', 'error handling');
  assert.match(withDiff, /^Review the changes below as a careful reviewer would\. Do not change any files\.\n\nFocus on: error handling\n\nThese are the changes made in this session/);
  assert.match(withDiff, /\+new\n\nReport, most serious first/);
  assert.match(reviewPrompt(undefined, ''), /Use `git diff` and `git status`/);
  assert.match(reviewPrompt('x'.repeat(40_000), ''), /diff cut at 30,000 characters/);
});
