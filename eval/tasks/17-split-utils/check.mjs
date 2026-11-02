import assert from 'node:assert/strict';
import { check, exists, files, finish, load, read } from '../../lib/check.mjs';

await check('utils.js deleted', () => assert.equal(exists('src/utils.js'), false));
await check('no import of utils left', () => assert.deepEqual(files('src').filter((f) => /utils(\.js)?['"]/.test(read(f))), []));
await check('strings.js', async () => {
  const s = await load('src/strings.js');
  assert.equal(s.capitalize('ab'), 'Ab');
  assert.equal(s.truncate('abcdef', 4), 'abc…');
});
await check('numbers.js', async () => {
  const n = await load('src/numbers.js');
  assert.equal(n.clamp(5, 0, 3), 3);
  assert.equal(n.roundTo(1.256, 2), 1.26);
});
await check('callers work', async () => {
  assert.equal((await load('src/label.js')).label('ann', 140), 'Ann: 100');
  assert.equal((await load('src/preview.js')).preview('hello there world', 0.4567), 'hello the… (45.7%)');
  const sh = await load('src/shout.js');
  assert.equal(sh.shout('hey'), 'Hey!');
  assert.equal(sh.percent(1.7), 100);
});
finish();
