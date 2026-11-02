import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const u = async (x) => (await load('src/user.js')).createUser(x);
const v = async (x) => (await load('src/validate.js')).validateUser(x);
await check('createUser keeps email', async () => assert.deepEqual(await u({ name: 'A', age: 3, email: 'a@b.co' }), { name: 'A', age: 3, email: 'a@b.co' }));
await check('valid user has no errors', async () => assert.deepEqual(await v({ name: 'A', age: 3, email: 'a@b.co' }), []));
await check('missing email', async () => assert.deepEqual(await v({ name: 'A', age: 3 }), ['email is invalid']));
await check('bad emails', async () => {
  for (const email of ['nope', 'a@b', '@b.co', 'a b@c.de']) assert.ok((await v({ name: 'A', age: 3, email })).includes('email is invalid'), email);
});
await check('other errors kept', async () => assert.equal((await v({ name: '', age: -1, email: 'x' })).length, 3));
await check('csv', async () => {
  const s = await load('src/serialize.js');
  assert.equal(s.CSV_HEADER, 'name,age,email');
  assert.equal(s.toCsvRow({ name: 'A', age: 3, email: 'a@b.co' }), 'A,3,a@b.co');
});
finish();
