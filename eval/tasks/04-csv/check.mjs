import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const p = async (l) => (await load('src/csv.js')).parseCsvLine(l);
await check('plain fields', async () => assert.deepEqual(await p('a,b,c'), ['a', 'b', 'c']));
await check('comma inside quotes', async () => assert.deepEqual(await p('a,"b,c",d'), ['a', 'b,c', 'd']));
await check('doubled quote', async () => assert.deepEqual(await p('"say ""hi""",x'), ['say "hi"', 'x']));
await check('empty fields', async () => assert.deepEqual(await p('a,,b'), ['a', '', 'b']));
await check('quoted empty', async () => assert.deepEqual(await p('"",z'), ['', 'z']));
finish();
