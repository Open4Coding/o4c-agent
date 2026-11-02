import assert from 'node:assert/strict';
import { check, files, finish, load, original, read } from '../../lib/check.mjs';

await check('default port 8080', async () => assert.equal((await load('app/main.js')).boot({}).listening, 8080));
await check('PORT still wins', async () => assert.equal((await load('app/main.js')).boot({ PORT: '9000' }).listening, 9000));
await check('timeouts untouched', async () => {
  const c = (await load('app/server/config/index.js')).getConfig({});
  assert.equal(c.timeoutMs, 3000);
  assert.equal(c.retries, 3);
});
await check('only the defaults file changed', () => {
  const changed = files('app').filter((f) => read(f) !== original(import.meta.url, f));
  assert.deepEqual(changed, ['app/server/config/defaults/index.js']);
});
finish();
