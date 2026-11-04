import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUnpackedRuntime, packageRoot, packageVersion, setPackageRoot } from '../packageRoot.js';
import { prepareSea } from '../sea.js';
import { bundledSkillsDir } from '../session/skills.js';

const saved = process.env.O4C_PACKAGE_ROOT;
afterEach(() => {
  if (saved === undefined) delete process.env.O4C_PACKAGE_ROOT;
  else process.env.O4C_PACKAGE_ROOT = saved;
});

test('normally the package root is the checkout, where grammars/, .docs/ and skills/ live', async () => {
  delete process.env.O4C_PACKAGE_ROOT;
  await prepareSea(); // not a single executable: nothing happens
  assert.equal(isUnpackedRuntime(), false);
  for (const d of ['grammars', '.docs', 'skills', 'package.json']) assert.ok(existsSync(join(packageRoot(), d)), d);
});

test('the single-executable root (set through the environment, so worker threads see it too) moves every asset path', () => {
  setPackageRoot('/runtime/0.0.1');
  assert.equal(isUnpackedRuntime(), true);
  assert.equal(packageRoot(), '/runtime/0.0.1');
  assert.equal(process.env.O4C_PACKAGE_ROOT, '/runtime/0.0.1');
  assert.equal(bundledSkillsDir(), join('/runtime/0.0.1', 'skills'));
});

test('packageVersion is the version in package.json - the one place it is written', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf-8')) as { version: string };
  assert.equal(packageVersion(), pkg.version);
  assert.match(packageVersion(), /^[0-9]+[.][0-9]+[.][0-9]+/);
});
