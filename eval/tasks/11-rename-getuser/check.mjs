import assert from 'node:assert/strict';
import { check, files, finish, load, read } from '../../lib/check.mjs';

await check('no getUsr left in src/', () => {
  const left = files('src').filter((f) => read(f).includes('getUsr'));
  assert.deepEqual(left, []);
});
await check('index exports getUser', async () => assert.equal((await load('src/index.js')).getUser(2).name, 'Linus'));
await check('callers work', async () => {
  const m = await load('src/index.js');
  assert.equal(m.orderSummary({ userId: 1, items: [1, 2] }), 'Ada ordered 2 item(s)');
  assert.equal(m.greeting(1), 'Hello, Ada!');
  assert.equal(m.greeting(9), 'Hello!');
});
finish();
