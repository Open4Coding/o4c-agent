import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysInMonth, isLeapYear } from '../src/dates.js';

test('ordinary leap year', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(daysInMonth(2024, 2), 29);
});
