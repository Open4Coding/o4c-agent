import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { indexSource } from '../graph/indexer.js';
import { CodeGraphComponent } from '../graph/toolHook.js';
import { mineCochange } from '../graph/cochange.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 D10: files that change together, and the tests that use a changed file. */

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...args], { cwd, stdio: 'ignore' });

test('after an edit: files usually changed with it, and tests that use it - once per file', { skip: !hasGit }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'o4c-cochange-'));
  git(root, 'init', '--quiet');
  await mkdir(join(root, 'tests'));
  for (let i = 0; i < 4; i++) {
    await writeFile(join(root, 'a.ts'), `export function shout(s: string) { return s + '${'!'.repeat(i + 1)}'; }\n`);
    await writeFile(join(root, 'b.ts'), `export const v = ${i};\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', `c${i}`);
  }
  await writeFile(join(root, 'c.ts'), 'export const c = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'c alone');
  const testSrc = "import { shout } from '../a';\nshout('x');\n";
  await writeFile(join(root, 'tests', 'a.test.ts'), testSrc);

  const mined = mineCochange(root)!;
  assert.equal(mined.files.get('a.ts'), 4);
  assert.equal(mined.pairs.get('a.ts\0b.ts'), 4);

  const store = new GraphStore(join(root, '.o4c', GRAPH_DB_FILENAME));
  try {
    const aSrc = "export function shout(s: string) { return s + '!!!!'; }\n";
    await indexSource(store, 'a.ts', aSrc);
    await indexSource(store, 'tests/a.test.ts', testSrc);
    const component = new CodeGraphComponent(store, root);
    const edit: Tool = { name: 'edit_file', description: '', inputSchema: {}, mutating: true, execute: async () => '' };
    const run = () => component.aroundTool({ tool: edit, input: { path: join(root, 'a.ts') } }, async () => 'Edited a.ts.');
    const first = await run();
    assert.match(first, /Usually changed together with a\.ts: b\.ts \(4 of 4 commits\)/);
    assert.match(first, /Tests that use what a\.ts defines: tests\/a\.test\.ts - run them before calling this done/);
    assert.equal(await run(), 'Edited a.ts.', 'once per file');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
