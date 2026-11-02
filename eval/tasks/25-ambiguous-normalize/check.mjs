import assert from 'node:assert/strict';
import { check, finish, load, original, read } from '../../lib/check.mjs';

const h = async (p) => (await load('src/routing/router.js')).handle(p);
await check('/users/ works', async () => assert.equal((await h('/users/')).status, 200));
await check('/users and //users// work', async () => {
  assert.equal((await h('/users')).status, 200);
  assert.equal((await h('//users//')).status, 200);
});
await check('/ is home', async () => assert.equal((await h('/')).body, 'home'));
await check('unknown is 404', async () => assert.equal((await h('/nope/')).status, 404));
await check('text normalize untouched', () => assert.equal(read('src/text/normalize.js'), original(import.meta.url, 'src/text/normalize.js')));
await check('search still works', async () => assert.equal((await load('src/search.js')).query('  Hello   World '), 'hello world'));
finish();
