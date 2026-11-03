import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIPS, tipFor } from '../ui/tips.js';

/** Plan 0006 E5: a rotating tip, one line each. */

test('tips rotate through the list and stay one line', () => {
  assert.equal(tipFor(0), TIPS[0]);
  assert.equal(tipFor(TIPS.length), TIPS[0]);
  assert.equal(tipFor(TIPS.length + 3), TIPS[3]);
  assert.equal(tipFor(-1), TIPS[TIPS.length - 1]);
  for (const t of TIPS) {
    assert.ok(!t.includes('\n') && t.length <= 140, t);
  }
});
