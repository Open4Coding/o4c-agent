import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Stack } from '../src/stack.js';

test('pop returns the last pushed value', () => {
  const s = new Stack().push(1).push(2).push(3);
  assert.equal(s.pop(), 3);
  assert.equal(s.pop(), 2);
  assert.equal(s.size, 1);
});

test('peek shows the top without removing it', () => {
  const s = new Stack().push('a').push('b');
  assert.equal(s.peek(), 'b');
  assert.equal(s.size, 2);
});

test('pop on an empty stack throws', () => {
  assert.throws(() => new Stack().pop());
});
