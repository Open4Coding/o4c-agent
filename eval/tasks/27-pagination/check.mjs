import assert from 'node:assert/strict';
import { check, finish, load, read } from '../../lib/check.mjs';

const get = async (query) => (await load('src/api.js')).handle({ method: 'GET', path: '/users', query });
await check('defaults', async () => {
  const r = await get({});
  assert.equal(r.status, 200);
  assert.equal(r.body.users.length, 20);
  assert.equal(r.body.total, 237);
  assert.equal(r.body.users[0].id, 1);
});
await check('limit and offset', async () => {
  const r = await get({ limit: '5', offset: '10' });
  assert.deepEqual(r.body.users.map((u) => u.id), [11, 12, 13, 14, 15]);
});
await check('with a filter', async () => {
  const r = await get({ active: 'false', limit: '3', offset: '1' });
  assert.equal(r.body.total, 79);
  assert.deepEqual(r.body.users.map((u) => u.id), [4, 7, 10]);
});
await check('past the end', async () => assert.deepEqual((await get({ offset: '500' })).body.users, []));
await check('bad values are 400', async () => {
  for (const q of [{ limit: '101' }, { limit: '-1' }, { offset: 'x' }, { limit: '2.5' }]) assert.equal((await get(q)).status, 400, JSON.stringify(q));
});
await check('limit 100 allowed', async () => assert.equal((await get({ limit: '100' })).body.users.length, 100));
await check('paging done in db.js', () => assert.ok(/slice|offset/.test(read('src/db.js'))));
finish();
