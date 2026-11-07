import assert from 'node:assert/strict';
import { atCommit, changedFiles, check, exists, finish, pathsIn, read, run } from '../../lib/check.mjs';

await check('names the class and its file', () => {
  const a = read('ANSWER.md');
  assert.ok(a.includes('src/vs/base/common/event.ts'), 'file path');
  assert.ok(/\bPauseableEmitter\b/.test(a), 'class name');
});
await check('nothing but ANSWER.md changed', () => assert.deepEqual(changedFiles(), ['ANSWER.md']));
finish();
