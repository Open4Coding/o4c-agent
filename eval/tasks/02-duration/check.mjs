import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const p = async (t) => (await load('lib/duration.js')).parseDuration(t);
await check('1h30m', async () => assert.equal(await p('1h30m'), 5400));
await check('2d', async () => assert.equal(await p('2d'), 172800));
await check('45s', async () => assert.equal(await p('45s'), 45));
await check('1d2h3m4s', async () => assert.equal(await p('1d2h3m4s'), 93784));
await check('rejects junk', async () => assert.rejects(p('abc')));
finish();
