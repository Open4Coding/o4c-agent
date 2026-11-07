import assert from 'node:assert/strict';
import { atCommit, changedFiles, check, exists, finish, pathsIn, read, run } from '../../lib/check.mjs';

await check('the helper is fixed and the file is the commit again', () => {
  assert.equal(read('src/vs/base/common/strings.ts'), atCommit('src/vs/base/common/strings.ts'));
});
await check('nothing else changed', () => assert.deepEqual(changedFiles().filter((f) => f !== 'ANSWER.md'), []));
finish();
