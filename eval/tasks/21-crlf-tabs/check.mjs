import assert from 'node:assert/strict';
import { check, finish, load, read } from '../../lib/check.mjs';

const f = async (items) => (await load('src/format.js')).formatList(items);
await check('empty', async () => assert.equal(await f([]), ''));
await check('one', async () => assert.equal(await f(['a']), 'a'));
await check('two', async () => assert.equal(await f(['a', 'b']), 'a and b'));
await check('three', async () => assert.equal(await f(['a', 'b', 'c']), 'a, b, and c'));
await check('four', async () => assert.equal(await f(['w', 'x', 'y', 'z']), 'w, x, y, and z'));
await check('still CRLF throughout', () => {
  const text = read('src/format.js');
  assert.equal(text.split('\r\n').length, text.split('\n').length, 'mixed or LF line endings');
});
await check('still tab-indented', () => assert.ok(!read('src/format.js').split('\r\n').some((l) => /^ {2,}\S/.test(l)), 'space-indented lines'));
await check('plural untouched', async () => assert.equal((await load('src/format.js')).plural('cat', 2), 'cats'));
finish();
