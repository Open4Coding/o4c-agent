import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * The suite must actually contain every test file.
 *
 * `npm test` is an explicit list of paths rather than a glob, which is a deliberate choice (the
 * order is meaningful - the slow UI files sit at the end) but has one failure mode: a new test
 * file that is simply never run. That is worse than having no test, because the file exists, it
 * passes when run directly, and it reports nothing while the thing it covers rots.
 *
 * Found the hard way: `mcpStartup.test.ts` was written, passed on its own, and then sat outside
 * the suite - the full run's total went up by the four tests added to an already-listed file and
 * by nothing else. Same family as the gap item 35 fixed, where `tsc` had never once looked at
 * `src/test/**`. One line of guard beats remembering.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Every `*.test.ts`/`*.test.tsx` under `src/test`, recursively, repo-relative with / separators. */
async function testFilesOnDisk(dir: string = TEST_DIR): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      found.push(...(await testFilesOnDisk(full)));
    } else if (/\.test\.tsx?$/.test(item.name)) {
      found.push(`src/test/${relative(TEST_DIR, full).split('\\').join('/')}`);
    }
  }
  return found;
}

test('every test file on disk is in the npm test script', async () => {
  const packageJson = JSON.parse(await readFile(join(TEST_DIR, '..', '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const script = packageJson.scripts.test;
  const onDisk = await testFilesOnDisk();

  assert.ok(onDisk.length > 40, `sanity check on the scan itself: found only ${onDisk.length} test files`);
  const missing = onDisk.filter((file) => !script.includes(file));
  assert.deepEqual(
    missing,
    [],
    `these test files exist but never run in the suite - add them to "test" in package.json:\n  ${missing.join('\n  ')}`,
  );
});

test('the npm test script lists no file that is gone', async () => {
  // The other direction: a renamed or deleted file left in the list takes the whole run down with
  // a module-not-found error, so this names it instead.
  const packageJson = JSON.parse(await readFile(join(TEST_DIR, '..', '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const listed = packageJson.scripts.test.match(/src\/test\/\S+\.tsx?/g) ?? [];
  const onDisk = new Set(await testFilesOnDisk());

  assert.ok(listed.length > 40, `sanity check on the parse itself: matched only ${listed.length} paths`);
  assert.deepEqual(listed.filter((file) => !onDisk.has(file)), []);
});
