import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const make = async (n) => new (await load('src/lru.js')).LRUCache(n);
await check('get/set', async () => {
  const c = await make(2);
  assert.equal(c.set('a', 1), c);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('zz'), undefined);
});
await check('evicts least recently used', async () => {
  const c = await make(2);
  c.set('a', 1).set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});
await check('has does not count as a use', async () => {
  const c = await make(2);
  c.set('a', 1).set('b', 2);
  c.has('a');
  c.set('c', 3);
  assert.equal(c.has('a'), false);
});
await check('replacing refreshes', async () => {
  const c = await make(2);
  c.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
  assert.equal(c.get('a'), 10);
  assert.equal(c.has('b'), false);
});
await check('delete', async () => {
  const c = await make(3);
  c.set('a', 1);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.size, 0);
});
finish();
