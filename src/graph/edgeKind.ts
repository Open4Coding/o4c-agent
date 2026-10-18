/**
 * Edge classification: what a reference actually asserts.
 *
 * This exists because of a measured failure, not a taste for taxonomy. lidx's compiler-graded
 * benchmark (PR #419, graded against `tsc`) reports that **410 of its 454 TypeScript false
 * positives were constants and variables read inside a function, recorded as `CALLS` edges**.
 * The same diagnostics put bare-name resolution precision at 0.86 for Go, 0.82 for TypeScript
 * and **0.48 for Rust** - and bare-name matching is exactly what tag extraction does. Labelling
 * every reference a call throws away the single cheapest precision win available.
 *
 * See `docs/research/code-graph/0001.INDEPENDENT-GRADING.md` §4. The three-way split itself
 * comes from graphify (`17.graphify.md`).
 */

/** What a reference edge claims. */
export type EdgeKind =
  /** A call site, syntactically. The reference appears where a call is being made. */
  | 'call'
  /**
   * Call-shaped but not uniquely resolvable - several definitions of the name exist, or none
   * does. **Assigned at resolution, never at extraction**, because extraction sees one file at a
   * time and cannot know how many definitions of a name the repository holds.
   */
  | 'call_reference'
  /** Not a call: a type annotation, a superclass, an import, a plain identifier read. */
  | 'usage';

/**
 * Capture-name fragments that mean "this is a call site".
 *
 * Matched as the capture's kind suffix. `send` is Ruby's and C#'s word for an invocation;
 * `method` is Java's, which is also why matching must never be on exact full capture names -
 * Java emits `name.reference.method` where JavaScript, Python, Go and Rust emit
 * `name.reference.call`.
 */
const CALL_KINDS = new Set(['call', 'method', 'send', 'invocation']);

/**
 * Classifies a reference capture.
 *
 * Returns `call` or `usage` only. `call_reference` is a resolution-stage verdict and this
 * function has no repository-wide view with which to assign it; a caller that resolves names
 * downgrades `call` to `call_reference` when the target is ambiguous or absent.
 */
export function edgeKindForCapture(capture: string): Exclude<EdgeKind, 'call_reference'> {
  const parts = capture.split('.');
  // `name.reference.call` -> kind `call`; anything shorter carries no kind.
  const kind = parts.length >= 3 ? parts[2] : '';
  return CALL_KINDS.has(kind) ? 'call' : 'usage';
}

/**
 * Whether an edge kind may be presented to the model as a call.
 *
 * `call_reference` is deliberately excluded. It means "this looks like a call but we could not
 * say to what", and reporting it as a call is the silent-wrongness this whole design is built to
 * avoid - the model asks what calls `validateToken`, is handed a guess, and acts on it.
 */
export function isAssertedCall(kind: EdgeKind): boolean {
  return kind === 'call';
}
