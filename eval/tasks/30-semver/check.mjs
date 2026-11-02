import assert from 'node:assert/strict';
import { check, finish, load } from '../../lib/check.mjs';

const m = () => load('src/semver.js');
await check('numeric parts', async () => assert.deepEqual((await m()).sortVersions(['1.10.0', '1.9.0', '1.2.10', '1.2.9', '10.0.0', '2.0.0']), ['1.2.9', '1.2.10', '1.9.0', '1.10.0', '2.0.0', '10.0.0']));
await check('pre-release order', async () => {
  const want = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  assert.deepEqual((await m()).sortVersions([...want].reverse()), want);
});
await check('build metadata ignored', async () => assert.equal((await m()).compare('1.0.0+build.5', '1.0.0+other'), 0));
await check('sign', async () => {
  const { compare } = await m();
  assert.ok(compare('1.0.1', '1.0.0') > 0);
  assert.ok(compare('0.9.0', '1.0.0') < 0);
  assert.equal(compare('3.4.5', '3.4.5'), 0);
});
finish();
