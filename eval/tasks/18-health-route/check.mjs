import assert from 'node:assert/strict';
import { check, files, finish, load } from '../../lib/check.mjs';

const handle = async (method, path) => (await load('src/app.js')).handle({ method, path });
await check('GET /health', async () => {
  const r = await handle('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(typeof r.body.uptime, 'number');
  assert.ok(r.body.uptime >= 0 && r.body.uptime < 600);
});
await check('POST /health is 404', async () => assert.equal((await handle('POST', '/health')).status, 404));
await check('users still served', async () => assert.equal((await handle('GET', '/users')).body[0].name, 'Ada'));
await check('own route file', () => assert.ok(files('src/routes').filter((f) => !f.endsWith('users.js')).length >= 1));
finish();
