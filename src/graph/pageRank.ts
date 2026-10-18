/**
 * Personalized PageRank by power iteration.
 *
 * This is the whole reason the Code Graph is a *ranking* feature rather than a `callers` query.
 * Externally-graded recall for resolved call graphs runs 0.026 to 0.967 across repositories with
 * nothing at query time saying which regime you hold
 * (`docs/research/code-graph/0001.INDEPENDENT-GRADING.md`). A `callers` answer over a graph like
 * that is confidently wrong; a *rank* over the same graph degrades gracefully, because a missing
 * edge slightly misorders a list and the output was never a completeness claim. That is also why
 * aider's 2023-era repo map has outlived every more sophisticated competitor.
 *
 * ~60 lines rather than a dependency on `networkx`, whose semantics this deliberately matches,
 * because aider's heuristics were tuned against them:
 *
 * - `alpha` 0.85, `tol` 1e-6 summed over absolute deltas, `maxIter` 100.
 * - Personalization replaces the uniform teleport vector, normalised to sum to 1.
 * - **Dangling nodes** - no out-edges - redistribute their mass through a separate weight
 *   vector. aider passes its personalization as the dangling vector too, which matters: without
 *   it, every leaf file leaks rank uniformly and the personalization is diluted.
 * - Parallel edges sum. aider builds a `MultiDiGraph` with one edge per identifier, and
 *   networkx's PageRank sums parallel weights when it forms the stochastic matrix.
 */

/** One weighted directed edge. `ident` is the identifier that justified it. */
export interface RankEdge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly ident: string;
}

export interface PageRankOptions {
  /** Damping factor. 0.85 is networkx's default and what aider's multipliers assume. */
  readonly alpha?: number;
  /** Teleport distribution, by node. Normalised internally; absent nodes get 0. */
  readonly personalization?: ReadonlyMap<string, number>;
  readonly maxIter?: number;
  readonly tol?: number;
}

export interface PageRankResult {
  /** Rank per node, summing to ~1. */
  readonly ranks: ReadonlyMap<string, number>;
  readonly iterations: number;
  /** False when the iteration hit `maxIter` without converging - ranks are still usable. */
  readonly converged: boolean;
}

/**
 * Ranks nodes over the given edges.
 *
 * `nodes` is passed separately from `edges` because a file with no shared identifiers at all
 * still needs a rank: it is a real file the model may want, just an unconnected one. Deriving
 * the node set from the edges alone would silently drop every isolated file.
 */
export function pageRank(
  nodes: readonly string[],
  edges: readonly RankEdge[],
  options: PageRankOptions = {},
): PageRankResult {
  const alpha = options.alpha ?? 0.85;
  const maxIter = options.maxIter ?? 100;
  const tol = options.tol ?? 1e-6;
  const n = nodes.length;

  if (n === 0) return { ranks: new Map(), iterations: 0, converged: true };

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node, i));

  // Out-adjacency with parallel edges summed, as networkx's stochastic graph does.
  const outTargets: number[][] = Array.from({ length: n }, () => []);
  const outWeights: number[][] = Array.from({ length: n }, () => []);
  const outTotal = new Float64Array(n);

  const merged = new Map<number, Map<number, number>>();
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (!(edge.weight > 0)) continue;
    let row = merged.get(from);
    if (!row) {
      row = new Map();
      merged.set(from, row);
    }
    row.set(to, (row.get(to) ?? 0) + edge.weight);
  }
  for (const [from, row] of merged) {
    for (const [to, weight] of row) {
      outTargets[from].push(to);
      outWeights[from].push(weight);
      outTotal[from] += weight;
    }
  }

  // Teleport vector. An empty or all-zero personalization falls back to uniform, matching
  // networkx's behaviour when no personalization is supplied.
  const teleport = new Float64Array(n);
  let personalSum = 0;
  if (options.personalization && options.personalization.size > 0) {
    for (const [node, value] of options.personalization) {
      const i = index.get(node);
      if (i !== undefined && value > 0) {
        teleport[i] += value;
        personalSum += value;
      }
    }
  }
  if (personalSum <= 0) {
    teleport.fill(1 / n);
  } else {
    for (let i = 0; i < n; i++) teleport[i] /= personalSum;
  }

  let x = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  let iterations = 0;
  let converged = false;

  for (let iter = 1; iter <= maxIter; iter++) {
    iterations = iter;
    next.fill(0);

    // Dangling mass: nodes with no out-edges. Redistributed through the teleport vector, which
    // is what keeps personalization from being diluted by every leaf in the repository.
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outTotal[i] === 0) dangling += x[i];

    for (let i = 0; i < n; i++) {
      const total = outTotal[i];
      if (total === 0) continue;
      const share = x[i] / total;
      const targets = outTargets[i];
      const weights = outWeights[i];
      for (let k = 0; k < targets.length; k++) next[targets[k]] += share * weights[k];
    }

    let delta = 0;
    for (let i = 0; i < n; i++) {
      const value = alpha * (next[i] + dangling * teleport[i]) + (1 - alpha) * teleport[i];
      delta += Math.abs(value - x[i]);
      next[i] = value;
    }

    const swap = x;
    x = next;
    next = swap;

    // networkx's test is `err < n * tol`.
    if (delta < n * tol) {
      converged = true;
      break;
    }
  }

  const ranks = new Map<string, number>();
  nodes.forEach((node, i) => ranks.set(node, x[i]));
  return { ranks, iterations, converged };
}
