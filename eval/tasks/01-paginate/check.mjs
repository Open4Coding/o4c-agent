import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
await check('page 1 is the first page', async () => assert.deepEqual((await load('src/paginate.js')).paginate(items, 1, 3), [1, 2, 3]));
await check('page 2', async () => assert.deepEqual((await load('src/paginate.js')).paginate(items, 2, 3), [4, 5, 6]));
await check('partial last page', async () => assert.deepEqual((await load('src/paginate.js')).paginate(items, 4, 3), [10]));
await check('past the end is empty', async () => assert.deepEqual((await load('src/paginate.js')).paginate(items, 5, 3), []));
await check('pageCount rounds up', async () => assert.equal((await load('src/paginate.js')).pageCount(items, 3), 4));
await check('pageCount exact', async () => assert.equal((await load('src/paginate.js')).pageCount(items.slice(0, 9), 3), 3));
await check('pageCount empty', async () => assert.equal((await load('src/paginate.js')).pageCount([], 3), 0));
finish();
