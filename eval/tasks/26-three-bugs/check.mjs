import assert from 'node:assert/strict';
import { check, finish, load, nodeTest, original, read } from '../../lib/check.mjs';

await check('tests unchanged', () => assert.equal(read('test/stats.test.js'), original(import.meta.url, 'test/stats.test.js')));
await check('node --test passes', () => {
  const r = nodeTest('test/stats.test.js');
  assert.equal(r.status, 0, r.stdout.slice(-300));
});
await check('hidden cases', async () => {
  const s = await load('src/stats.js');
  assert.equal(s.median([10, 2]), 6);
  assert.equal(s.mode([9, 9, 4, 4, 7, 7]), 4);
  assert.ok(Math.abs(s.stddev([1, 2, 3, 4]) - 1.29099) < 0.0001);
});
finish();
