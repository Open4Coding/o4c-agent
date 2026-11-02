import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

await check('create rejects blank and non-string', async () => {
  const h = await load('src/handlers.js');
  for (const name of ['   ', '', 42, null]) assert.deepEqual(h.handleCreate({ name }), { ok: false, error: 'name is required' }, String(name));
});
await check('update rejects blank and non-string', async () => {
  const h = await load('src/handlers.js');
  const { item } = h.handleCreate({ name: 'a' });
  for (const name of ['   ', 7]) assert.deepEqual(h.handleUpdate(item.id, { name }), { ok: false, error: 'name is required' }, String(name));
});
await check('valid names still work', async () => {
  const h = await load('src/handlers.js');
  const { item } = h.handleCreate({ name: ' bob ' });
  assert.equal(item.name, 'bob');
  assert.equal(h.handleUpdate(item.id, { name: 'rob' }).item.name, 'rob');
  assert.deepEqual(h.handleCreate({ name: 'x'.repeat(51) }), { ok: false, error: 'name is too long' });
  assert.deepEqual(h.handleUpdate(999, { name: 'a' }), { ok: false, error: 'not found' });
});
finish();
