import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { check, finish, run } from '../../lib/check.mjs';

writeFileSync('sample-check.txt', 'hello world\nfoo   bar\tbaz\n\nlast line here\n');
writeFileSync('empty-check.txt', '');
const wc = (...args) => {
  const r = run(process.execPath, ['bin/wc.js', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
await check('lines by default', () => assert.equal(wc('sample-check.txt'), '4'));
await check('--words before the file', () => assert.equal(wc('--words', 'sample-check.txt'), '8'));
await check('--words after the file', () => assert.equal(wc('sample-check.txt', '--words'), '8'));
await check('empty file has 0 words', () => assert.equal(wc('--words', 'empty-check.txt'), '0'));
finish();
