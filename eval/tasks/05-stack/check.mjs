import assert from 'node:assert/strict';
import { check, finish, load, nodeTest, original, read } from '../../lib/check.mjs';

await check('tests unchanged', () => assert.equal(read('test/stack.test.js'), original(import.meta.url, 'test/stack.test.js')));
await check('node --test passes', () => {
  const r = nodeTest('test/stack.test.js');
  assert.equal(r.status, 0, r.stdout.slice(-400));
});
await check('LIFO with peek', async () => {
  const { Stack } = await load('src/stack.js');
  const s = new Stack().push(1).push(2);
  assert.equal(s.peek(), 2);
  assert.equal(s.pop(), 2);
  assert.equal(s.peek(), 1);
  assert.equal(s.pop(), 1);
  assert.equal(s.isEmpty(), true);
  assert.equal(s.peek(), undefined);
});
finish();
