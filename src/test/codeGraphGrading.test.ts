import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Z_95,
  assertPartition,
  formatRate,
  grade,
  rate,
  wilsonInterval,
  type GradeCounts,
} from '../graph/grading.js';

/**
 * The grading arithmetic, checked against published Wilson values rather than against itself.
 *
 * This file exists because of a specific mistake: earlier in this project I quoted a recall
 * figure from the literature that was a single cell of a table the author forbade reading that
 * way, and it propagated into a design document and a memory file before being caught. Numbers
 * that back a decision have to be checkable, and the first thing to check is that the routine
 * computing them is right.
 */

// ------------------------------------------------------------------ Wilson

test('Wilson matches published 95% intervals', () => {
  // Textbook reference values for n = 10 (Wilson 1927; any statistics table agrees).
  const half = wilsonInterval(5, 10);
  assert.equal(half.lower.toFixed(4), '0.2366');
  assert.equal(half.upper.toFixed(4), '0.7634');

  const none = wilsonInterval(0, 10);
  assert.equal(none.lower, 0);
  assert.equal(none.upper.toFixed(4), '0.2775');

  const all = wilsonInterval(10, 10);
  assert.equal(all.lower.toFixed(4), '0.7225');
  assert.equal(all.upper, 1);
});

test('the interval stays inside [0,1] where the normal approximation would not', () => {
  // The normal approximation gives 1 +/- 0 at 3/3, and negative lower bounds near zero. Both are
  // nonsense, and both appear exactly in the small cells this measurement has most of.
  for (const [k, n] of [[0, 1], [1, 1], [0, 3], [3, 3], [1, 2], [19, 20], [1, 20]] as const) {
    const i = wilsonInterval(k, n);
    assert.ok(i.lower >= 0 && i.upper <= 1, `${k}/${n} gave [${i.lower}, ${i.upper}]`);
    assert.ok(i.lower <= k / n && k / n <= i.upper, `${k}/${n} interval must contain the estimate`);
  }
});

test('no trials means the whole range, not zero', () => {
  // A cell with nothing in it must not read as "0%, measured".
  const i = wilsonInterval(0, 0);
  assert.deepEqual(i, { lower: 0, upper: 1 });
  assert.equal(rate(0, 0).value, 0);
});

test('the interval narrows as the sample grows', () => {
  const widths = [10, 100, 1000, 10000].map((n) => {
    const i = wilsonInterval(n / 2, n);
    return i.upper - i.lower;
  });
  for (let k = 1; k < widths.length; k++) {
    assert.ok(widths[k] < widths[k - 1], `width should shrink: ${widths.join(' > ')}`);
  }
  // A 20-item hand-check is wide enough that this has to be stated when quoting one.
  const twenty = wilsonInterval(18, 20);
  assert.ok(twenty.upper - twenty.lower > 0.2, 'a sample of 20 carries at least 20 points of slack');
});

test('impossible counts throw instead of returning a figure', () => {
  assert.throws(() => wilsonInterval(5, 3), /impossible/);
  assert.throws(() => wilsonInterval(-1, 3), /impossible/);
  assert.throws(() => wilsonInterval(1.5, 3), /whole counts/);
});

// ------------------------------------------------------------------ precision and recall

const counts = (over: Partial<GradeCounts> = {}): GradeCounts => ({
  asserted: 100,
  truePositives: 80,
  falsePositives: 10,
  falseNegatives: 40,
  outOfUniverse: 10,
  oracleEdges: 120,
  ...over,
});

test('precision and recall come out of the same call', () => {
  const g = grade(counts());
  assert.equal(g.precision.value, 80 / 90, 'precision is over graded edges, not over asserted');
  assert.equal(g.recall.value, 80 / 120);
  assert.equal(g.f1.toFixed(4), '0.7619');
  assert.ok(g.precision.interval.lower > 0 && g.recall.interval.upper < 1);
});

test('out-of-universe edges are excluded from precision, not counted as wrong', () => {
  // A call into node_modules is neither a hit nor a miss - the oracle never ruled on it. Folding
  // those into false positives would understate precision by however many library calls the
  // repository happens to make, which is most of them.
  const withLibraryCalls = grade(counts({ asserted: 500, outOfUniverse: 410 }));
  assert.equal(withLibraryCalls.precision.value, 80 / 90);
  assert.equal(withLibraryCalls.precision.trials, 90);
});

test('the partition is enforced, so counts that do not add up cannot be reported', () => {
  assert.throws(() => grade(counts({ asserted: 99 })), /asserted edges but 100 accounted for/);
  assert.throws(() => grade(counts({ oracleEdges: 121 })), /oracle holds 121 edges/);
  assert.doesNotThrow(() => assertPartition(counts()));
});

test('asserting fewer edges raises precision and lowers recall', () => {
  // The reason both are always reported: this transformation makes one number better and the
  // component worse, and either figure alone hides it.
  const before = grade(counts({ asserted: 100, truePositives: 80, falsePositives: 10, outOfUniverse: 10, falseNegatives: 40, oracleEdges: 120 }));
  const after = grade(counts({ asserted: 50, truePositives: 40, falsePositives: 0, outOfUniverse: 10, falseNegatives: 80, oracleEdges: 120 }));

  assert.ok(after.precision.value > before.precision.value, 'precision improved');
  assert.ok(after.recall.value < before.recall.value, 'recall got worse');
  assert.ok(after.f1 < before.f1, 'and the pair taken together got worse');
});

test('a perfect score and an empty prediction are both representable', () => {
  const perfect = grade({ asserted: 10, truePositives: 10, falsePositives: 0, falseNegatives: 0, outOfUniverse: 0, oracleEdges: 10 });
  assert.equal(perfect.precision.value, 1);
  assert.equal(perfect.recall.value, 1);
  assert.equal(perfect.f1, 1);

  const nothing = grade({ asserted: 0, truePositives: 0, falsePositives: 0, falseNegatives: 10, outOfUniverse: 0, oracleEdges: 10 });
  assert.equal(nothing.recall.value, 0);
  assert.equal(nothing.f1, 0, 'no assertions means no credit, not a divide-by-zero');
  assert.deepEqual(nothing.precision.interval, { lower: 0, upper: 1 }, 'precision over nothing is unmeasured');
});

// ------------------------------------------------------------------ formatting

test('a formatted rate carries its counts and its interval', () => {
  // Every figure that reaches a document goes through here, so a reader can always see the
  // sample size the percentage came from.
  const text = formatRate(rate(80, 90));
  assert.match(text, /88\.9%/);
  assert.match(text, /\(80\/90/);
  assert.match(text, /95% CI/);
  assert.equal(Z_95.toFixed(2), '1.96');
});
