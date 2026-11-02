import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const wait = (ms, v) => () => new Promise((r) => setTimeout(() => r(v), ms));
await check('results in job order', async () => {
  const { runAll } = await load('src/batch.js');
  assert.deepEqual(await runAll([wait(120, 'a'), wait(10, 'b'), wait(60, 'c')]), ['a', 'b', 'c']);
});
await check('runs concurrently', async () => {
  const { runAll } = await load('src/batch.js');
  const t = Date.now();
  await runAll([wait(200), wait(200), wait(200)]);
  assert.ok(Date.now() - t < 450, `took ${Date.now() - t} ms`);
});
await check('a failing job rejects', async () => {
  const { runAll } = await load('src/batch.js');
  await assert.rejects(runAll([wait(10, 1), () => Promise.reject(new Error('boom'))]));
});
await check('no jobs', async () => assert.deepEqual(await (await load('src/batch.js')).runAll([]), []));
finish();
