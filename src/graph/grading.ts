/**
 * How the code graph is graded, and why the arithmetic lives in tested code rather than in a
 * script that prints numbers.
 *
 * The research review (`docs/research/code-graph/0001.INDEPENDENT-GRADING.md`) turned up two
 * things that shape this file:
 *
 * 1. **Recall figures in this field vary from 0.026 to 0.967** across repositories with no signal
 *    available at query time to say which you are in. A single headline number is therefore
 *    nearly meaningless; what matters is the pair, the interval around it, and whether it holds
 *    across more than one repository.
 * 2. I have already quoted a figure from that literature wrongly once in this project, by lifting
 *    one cell out of a table whose author explicitly forbade cross-row comparison. The defence
 *    against repeating that is to make every published number re-derivable from stored counts by
 *    a test, which is what `codeGraphAcceptance.test.ts` does with the output of this module.
 *
 * Precision and recall are returned together, always. They trade against each other, so either
 * one alone can be made to look good by a change that makes the component worse: assert fewer
 * edges and precision climbs, assert everything and recall does.
 */

/** z for a two-sided 95% interval. */
export const Z_95 = 1.959964;

export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

/**
 * Wilson score interval for a proportion.
 *
 * Used rather than the textbook normal approximation because the cells that matter here are the
 * small ones - a hand-checked sample of 20, or a language with 30 call sites - and the normal
 * approximation is worst exactly there, happily reporting bounds below 0 or above 1. Wilson stays
 * inside [0, 1] and stays sane at k = 0 and k = n.
 *
 * With no trials the honest interval is the whole range: nothing was measured.
 */
export function wilsonInterval(successes: number, trials: number, z: number = Z_95): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error('wilsonInterval needs whole counts');
  }
  if (trials < 0 || successes < 0 || successes > trials) {
    throw new Error(`wilsonInterval: ${successes} successes out of ${trials} trials is impossible`);
  }
  if (trials === 0) return { lower: 0, upper: 1 };

  const z2 = z * z;
  const centre = (successes + z2 / 2) / (trials + z2);
  const spread =
    (z / (trials + z2)) *
    Math.sqrt((successes * (trials - successes)) / trials + z2 / 4);

  return { lower: Math.max(0, centre - spread), upper: Math.min(1, centre + spread) };
}

/** A proportion with the interval that says how much to trust it. */
export interface Rate {
  readonly value: number;
  readonly successes: number;
  readonly trials: number;
  readonly interval: Interval;
}

export function rate(successes: number, trials: number, z: number = Z_95): Rate {
  return {
    value: trials === 0 ? 0 : successes / trials,
    successes,
    trials,
    interval: wilsonInterval(successes, trials, z),
  };
}

/**
 * The counts a comparison against an oracle produces.
 *
 * `asserted` is deliberately separate from `truePositives + falsePositives`: a predicted edge
 * whose call site the oracle never considered (a call into a library, say) is neither right nor
 * wrong, it is **out of the oracle's universe**, and silently counting it either way is how a
 * precision figure becomes a lie. `outOfUniverse` keeps that visible and `assertPartition` proves
 * the buckets add up.
 */
export interface GradeCounts {
  readonly asserted: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly outOfUniverse: number;
  readonly oracleEdges: number;
}

export interface Grade {
  readonly counts: GradeCounts;
  readonly precision: Rate;
  readonly recall: Rate;
  /** Harmonic mean, reported because it is asked for, and never alone. */
  readonly f1: number;
}

/**
 * Precision and recall from raw counts, with the partition checked rather than assumed.
 *
 * Throws instead of returning a wrong figure. A grading routine that quietly tolerates counts
 * which do not add up is worse than no grading at all, because its output looks like evidence.
 */
export function grade(counts: GradeCounts, z: number = Z_95): Grade {
  assertPartition(counts);

  const graded = counts.truePositives + counts.falsePositives;
  const precision = rate(counts.truePositives, graded, z);
  const recall = rate(counts.truePositives, counts.truePositives + counts.falseNegatives, z);
  const denominator = precision.value + recall.value;

  return {
    counts,
    precision,
    recall,
    f1: denominator === 0 ? 0 : (2 * precision.value * recall.value) / denominator,
  };
}

export function assertPartition(counts: GradeCounts): void {
  const parts =
    counts.truePositives + counts.falsePositives + counts.outOfUniverse;
  if (parts !== counts.asserted) {
    throw new Error(
      `grade: ${counts.asserted} asserted edges but ${parts} accounted for ` +
        `(tp ${counts.truePositives} + fp ${counts.falsePositives} + out-of-universe ${counts.outOfUniverse})`,
    );
  }
  const covered = counts.truePositives + counts.falseNegatives;
  if (covered !== counts.oracleEdges) {
    throw new Error(
      `grade: oracle holds ${counts.oracleEdges} edges but ${covered} accounted for ` +
        `(tp ${counts.truePositives} + fn ${counts.falseNegatives})`,
    );
  }
}

/** Fixed-width percentage, so a stored figure and a printed one cannot disagree by rounding. */
export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRate(r: Rate, digits = 1): string {
  return (
    `${pct(r.value, digits)} (${r.successes}/${r.trials}, ` +
    `95% CI ${pct(r.interval.lower, digits)}-${pct(r.interval.upper, digits)})`
  );
}
