/**
 * Which files are worth indexing.
 *
 * This exists because of a failure caught while testing the ranker, not from theory. Running the
 * ranking over aider's repository put `aider/website/assets/asciinema/asciinema-player.min.js`
 * at rank 1 with 0.13984 - **twice the next file** - and pulled `addEventListener` and `set`
 * into the top definitions. A minified vendor bundle is close to the least useful file in a
 * repository, but it contains thousands of identifier references on a handful of lines, so it
 * dominates a reference graph completely.
 *
 * The ranker was behaving correctly; the input was wrong. Garbage of this kind has to be
 * excluded before it reaches the graph, because no weighting heuristic can recover from a single
 * node holding a large fraction of all edges.
 *
 * aider sidesteps this by being handed a curated list (git-tracked files, honouring ignore
 * rules). o4c indexes a working tree directly, so it needs the judgement here.
 */

/** Hard ceiling on indexed file size. Above this a file is machine-generated or data, not code. */
export const MAX_INDEXED_BYTES = 1024 * 1024;

/**
 * A line this long means the file is not written by a person.
 *
 * Minified JavaScript routinely puts an entire bundle on one line. Hand-written code, even
 * badly formatted, does not reach this.
 */
const MAX_MEAN_LINE_LENGTH = 400;

/** Path fragments that mark generated or vendored output regardless of content. */
const GENERATED_PATH_PATTERNS = [
  /\.min\.(js|css|mjs|cjs)$/i,
  /\.bundle\.(js|css|mjs|cjs)$/i,
  /[.-]generated\./i,
  /\.d\.ts$/i,
  /(^|\/)vendor\//i,
  /(^|\/)third_party\//i,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.min\//,
];

/** Why a file was rejected - surfaced so a caller can report rather than silently drop. */
export type SkipReason = 'too-large' | 'generated-path' | 'minified-content' | 'no-newlines';

/**
 * Decides whether to index a file, and says why not when the answer is no.
 *
 * `undefined` means "index it". A reason means skip, and the caller should treat that as a
 * deliberate exclusion it can explain - not as a file with no definitions.
 */
export function skipReasonFor(path: string, source: string): SkipReason | undefined {
  if (source.length > MAX_INDEXED_BYTES) return 'too-large';

  const normalised = path.replace(/\\/g, '/');
  if (GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(normalised))) return 'generated-path';

  // Content check, so a bundle that does not advertise itself in its name is still caught.
  const newlines = countNewlines(source);
  if (newlines === 0 && source.length > 2000) return 'no-newlines';
  if (newlines > 0 && source.length / (newlines + 1) > MAX_MEAN_LINE_LENGTH) return 'minified-content';

  return undefined;
}

/** Convenience inverse of `skipReasonFor`. */
export function shouldIndex(path: string, source: string): boolean {
  return skipReasonFor(path, source) === undefined;
}

function countNewlines(source: string): number {
  let count = 0;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) count++;
  return count;
}
