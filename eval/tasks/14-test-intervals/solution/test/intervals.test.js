import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeIntervals } from '../src/intervals.js';

test('overlap', () => assert.deepEqual(mergeIntervals([[1, 4], [2, 3]]), [[1, 4]]));
test('touching', () => assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]));
test('sorted', () => assert.deepEqual(mergeIntervals([[8, 9], [1, 2]]), [[1, 2], [8, 9]]));
test('input untouched', () => {
  const input = [[1, 3], [2, 6]];
  mergeIntervals(input);
  assert.deepEqual(input, [[1, 3], [2, 6]]);
});
