import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const make = async () => new (await load('src/emitter.js')).Emitter();
await check('fires once with args', async () => {
  const e = await make();
  const got = [];
  assert.equal(e.once('x', (a, b) => got.push(a + b)), e);
  e.emit('x', 1, 2);
  e.emit('x', 3, 4);
  assert.deepEqual(got, [3]);
});
await check('off removes a once handler', async () => {
  const e = await make();
  let n = 0;
  const h = () => n++;
  e.once('x', h);
  e.off('x', h);
  e.emit('x');
  assert.equal(n, 0);
});
await check('on handlers unaffected', async () => {
  const e = await make();
  let n = 0;
  e.on('x', () => n++);
  e.once('x', () => n += 10);
  e.emit('x');
  e.emit('x');
  assert.equal(n, 12);
});
await check('emit return value', async () => {
  const e = await make();
  e.once('x', () => {});
  assert.equal(e.emit('x'), true);
  assert.equal(e.emit('x'), false);
});
finish();
