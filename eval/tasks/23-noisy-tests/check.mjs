import assert from 'node:assert/strict';
import { check, finish, load, original, read, run } from '../../lib/check.mjs';

await check('tests unchanged', () => assert.equal(read('test/run.mjs'), original(import.meta.url, 'test/run.mjs')));
await check('test/run.mjs passes', () => {
  const r = run(process.execPath, ['test/run.mjs']);
  assert.equal(r.status, 0, r.stdout.split('\n').filter((l) => l.startsWith('not ok')).join(' | '));
});
await check('split shares', async () => {
  const { split } = await load('src/money.js');
  assert.deepEqual(split(10, 4), [3, 3, 2, 2]);
  assert.deepEqual(split(7, 7), [1, 1, 1, 1, 1, 1, 1]);
});
await check('addTax', async () => assert.equal((await load('src/money.js')).addTax(999, 0.15), 1149));
finish();
