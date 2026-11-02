import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mean, median, mode, stddev } from '../src/stats.js';

test('mean', () => assert.equal(mean([1, 2, 3, 4]), 2.5));
test('median odd', () => assert.equal(median([3, 1, 2]), 2));
test('median even', () => assert.equal(median([4, 1, 3, 2]), 2.5));
test('median does not modify its input', () => {
  const xs = [3, 1, 2];
  median(xs);
  assert.deepEqual(xs, [3, 1, 2]);
});
test('mode', () => assert.equal(mode([1, 2, 2, 3]), 2));
test('mode tie picks the smallest', () => assert.equal(mode([5, 5, 1, 1, 3]), 1));
test('stddev is the sample standard deviation', () => assert.ok(Math.abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001));
