import assert from 'node:assert/strict';
import { check, exists, finish, mutate, nodeTest, original, read } from '../../lib/check.mjs';

const SRC = 'src/slugify.js';
const TEST = 'test/slugify.test.js';
const MUTANTS = [
  [".toLowerCase()", ""],
  [".replace(/^-+|-+$/g, '')", ""],
  ["/[^a-z0-9]+/g", "/[^a-z0-9]/g"],
  [".replace(/[\\u0300-\\u036f]/g, '')", ""],
];
await check('test file exists', () => assert.ok(exists(TEST)));
await check('source unchanged', () => assert.equal(read(SRC), original(import.meta.url, SRC)));
await check('tests pass on the real code', () => {
  const r = nodeTest(TEST);
  assert.equal(r.status, 0, r.stdout.slice(-400));
});
await check('tests catch broken versions (3 of 4 needed)', () => {
  const caught = MUTANTS.filter(([from, to]) => mutate(SRC, from, to, () => nodeTest(TEST).status !== 0));
  assert.ok(caught.length >= 3, `caught ${caught.length} of ${MUTANTS.length}`);
});
finish();
