import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { check, finish, load, read } from '../../lib/check.mjs';

writeFileSync('people-check.json', JSON.stringify([{ name: 'Zoe' }, { name: 'Al' }, { name: 'Mo' }]));
writeFileSync('bad-check.json', '{nope');
await check('load returns a promise of the data', async () => {
  const p = (await load('src/store.js')).load('people-check.json');
  assert.equal(typeof p?.then, 'function');
  assert.equal((await p).length, 3);
});
await check('bad JSON rejects', async () => assert.rejects((await load('src/store.js')).load('bad-check.json')));
await check('missing file rejects', async () => assert.rejects((await load('src/store.js')).load('nope-check.json')));
await check('sortedNames resolves', async () => assert.deepEqual(await (await load('src/main.js')).sortedNames('people-check.json'), ['Al', 'Mo', 'Zoe']));
await check('sortedNames rejects', async () => assert.rejects((await load('src/main.js')).sortedNames('nope-check.json')));
await check('no callbacks left', () => assert.ok(!/callback/.test(read('src/store.js') + read('src/main.js'))));
finish();
