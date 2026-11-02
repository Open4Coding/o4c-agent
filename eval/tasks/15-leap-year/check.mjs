import assert from 'node:assert/strict';
import { check, finish, load, mutate, nodeTest, read } from '../../lib/check.mjs';

await check('isLeapYear correct', async () => {
  const { isLeapYear } = await load('src/dates.js');
  for (const [y, v] of [[1900, false], [2000, true], [2023, false], [2024, true], [2100, false], [2400, true]]) assert.equal(isLeapYear(y), v, String(y));
});
await check('tests mention 1900 and 2000', () => {
  const t = read('test/dates.test.js');
  assert.ok(t.includes('1900') && t.includes('2000'));
});
await check('tests pass', () => {
  const r = nodeTest('test/dates.test.js');
  assert.equal(r.status, 0, r.stdout.slice(-400));
});
await check('tests fail on the old code', () => {
  const src = read('src/dates.js');
  const body = src.match(/export function isLeapYear\(year\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(body, 'isLeapYear not found');
  const failed = mutate('src/dates.js', body, 'export function isLeapYear(year) {\n  return year % 4 === 0;\n}', () => nodeTest('test/dates.test.js').status !== 0);
  assert.ok(failed);
});
finish();
