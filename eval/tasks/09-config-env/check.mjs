import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const defaults = { port: 8080, debug: false, name: 'app', log_level: 'info' };
const lc = async (...a) => (await load('src/config.js')).loadConfig(...a);
await check('defaults only', async () => assert.deepEqual(await lc(defaults, {}, {}), defaults));
await check('typed env values', async () =>
  assert.deepEqual(await lc(defaults, {}, { APP_PORT: '9000', APP_DEBUG: 'true', APP_NAME: 'x', APP_LOG_LEVEL: 'warn' }), {
    port: 9000,
    debug: true,
    name: 'x',
    log_level: 'warn',
  }));
await check('overrides beat env', async () => assert.equal((await lc(defaults, { port: 1 }, { APP_PORT: '9000' })).port, 1));
await check('unrelated env ignored', async () => assert.equal('other' in (await lc(defaults, {}, { APP_OTHER: '1' })), false));
await check('defaults to process.env', async () => {
  process.env.APP_PORT = '7777';
  assert.equal((await lc(defaults)).port, 7777);
});
finish();
