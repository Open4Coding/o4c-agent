import assert from 'node:assert/strict';
import { atCommit, changedFiles, check, exists, finish, pathsIn, read, run } from '../../lib/check.mjs';

const before = run('git', ['grep', '-l', '-w', 'PauseableEmitter', 'HEAD', '--', 'src']).stdout.split('\n').filter(Boolean).map((l) => l.replace(/^HEAD:/, ''));
await check('no PauseableEmitter left', () => {
  const left = run('git', ['grep', '-l', '-w', 'PauseableEmitter', '--', 'src']).stdout.split('\n').filter(Boolean);
  assert.deepEqual(left, []);
});
await check('every file that used it now uses PausableEmitter, the same number of times', () => {
  for (const f of before) {
    // Counting both spellings: a test file already says PausableEmitter once.
    const was = (atCommit(f).match(/\bPaus(e)?ableEmitter\b/g) ?? []).length;
    const now = (read(f).match(/\bPausableEmitter\b/g) ?? []).length;
    assert.equal(now, was, f);
  }
});
await check('nothing else changed', () => {
  assert.deepEqual(changedFiles().filter((f) => f !== 'ANSWER.md'), [...before].sort());
  const one = (s) => s.replace(/\bPaus(e)?ableEmitter\b/g, 'PausableEmitter');
  for (const f of before) assert.equal(read(f), one(atCommit(f)), f);
});
finish();
