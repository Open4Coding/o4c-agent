/**
 * Resolution: turning references into edges, and turning "I found nothing" into a claim that
 * says how hard it looked.
 *
 * Extraction (step 2) deliberately stores `(file, name)` references rather than
 * `caller -> callee` edges, because a single file's parse cannot know how many definitions of a
 * name the repository holds. This is where that is decided, and it is needed by two callers for
 * different reasons:
 *
 * - **The acceptance test** needs gradeable edges to compare against `tsc`'s own resolution.
 * - **The tool-dispatch hook** (step 4) needs to answer "where is this defined" without
 *   re-deriving any of it.
 *
 * ## The honesty contract
 *
 * Resolution is where this component starts making claims, so it is where the four-state verdict
 * from `26.jcodemunch-mcp.md` belongs. o4c intercepts `grep`, which the model trusts to be
 * exhaustive, so an empty answer has to distinguish *"I searched 1,200 files and this name is
 * defined nowhere"* from *"my index does not cover this"*. Those are different facts and only one
 * of them licenses deleting code.
 *
 * ## What this cannot do
 *
 * Resolution is by **name**, not by type. Overloads, interface dispatch, generics and anything
 * reached through a value are invisible. lidx's compiler-graded diagnostics put bare-name
 * resolution precision at 0.86 for Go, 0.82 for TypeScript and 0.48 for Rust
 * (`docs/research/code-graph/0001.INDEPENDENT-GRADING.md` §4), and bare-name matching is exactly
 * what happens here. That is the reason ambiguity gets its own edge kind rather than a guess.
 */

import type { DefinitionRow, GraphStore } from './graphStore.js';
import { isAssertedCall, type EdgeKind } from './edgeKind.js';
import { normalisePath } from './entityId.js';

/**
 * How much weight an answer can bear.
 *
 * - `ok` - exactly one definition. Safe to act on.
 * - `low_confidence` - several candidates and no way to choose between them by name alone.
 * - `absent` - **a positive claim**: the index is complete and this name is defined nowhere in
 *   it. Backed by the scan counts, because a claim like this must be falsifiable.
 * - `degraded` - the index cannot answer. Silence proves nothing here, and a caller must not
 *   present it as absence.
 */
export type ResolutionVerdict = 'ok' | 'low_confidence' | 'absent' | 'degraded';

/** What the index was able to look at, so a verdict can be checked rather than believed. */
export interface ScanCounts {
  readonly filesIndexed: number;
  readonly definitionsIndexed: number;
  readonly candidatesFound: number;
}

export interface NameResolution {
  readonly name: string;
  readonly verdict: ResolutionVerdict;
  /** Candidates, best first. Empty for `absent` and `degraded`. */
  readonly definitions: readonly DefinitionRow[];
  /** One sentence, written for the model rather than for a log. */
  readonly note: string;
  readonly scanned: ScanCounts;
}

export interface ResolveOptions {
  /**
   * Whether the index can be trusted to be complete for this question.
   *
   * The store cannot know this on its own - freshness is a property of bytes on disk that only
   * the caller has. Passing `'incomplete'` turns what would be `absent` into `degraded`, which
   * is the whole point: **`absent` must never be asserted over an index that might be stale.**
   */
  readonly indexStatus?: 'fresh' | 'incomplete';
}

/**
 * Where a name is defined, with a verdict about how much the answer is worth.
 *
 * Candidate ordering prefers a definition in the referencing file when `fromPath` is given,
 * because lexical scope makes a same-file definition overwhelmingly the likely target. That is a
 * heuristic, stated as one; whether it earns its place is a question the acceptance test answers.
 */
export function resolveName(
  store: GraphStore,
  name: string,
  fromPath?: string,
  options: ResolveOptions = {},
): NameResolution {
  const stats = store.stats();
  const incomplete = options.indexStatus === 'incomplete';

  if (stats.files === 0) {
    return {
      name,
      verdict: 'degraded',
      definitions: [],
      note: 'The code graph holds no files, so it cannot say anything about this name.',
      scanned: { filesIndexed: 0, definitionsIndexed: 0, candidatesFound: 0 },
    };
  }

  const candidates = store.definitionsOf(name);
  const scanned: ScanCounts = {
    filesIndexed: stats.files,
    definitionsIndexed: stats.defs,
    candidatesFound: candidates.length,
  };

  if (candidates.length === 0) {
    return incomplete
      ? {
          name,
          verdict: 'degraded',
          definitions: [],
          note:
            `No definition of "${name}" is indexed, but the index is known to be out of date, ` +
            'so this is not evidence that none exists.',
          scanned,
        }
      : {
          name,
          verdict: 'absent',
          definitions: [],
          note:
            `No definition of "${name}" in ${stats.files} indexed files ` +
            `(${stats.defs} definitions scanned). Languages without a bundled grammar are not covered.`,
          scanned,
        };
  }

  const ordered = orderCandidates(candidates, fromPath);

  // A same-file definition is treated as decisive even when others share the name, because
  // lexical scope means that is what the language itself would pick.
  const home = fromPath ? normalisePath(fromPath) : undefined;
  const sameFile = home ? candidates.filter((c) => c.path === home) : [];
  if (sameFile.length === 1) {
    return {
      name,
      verdict: 'ok',
      definitions: ordered,
      note:
        candidates.length === 1
          ? `Defined once, in ${sameFile[0].path}.`
          : `Defined in the referencing file (${sameFile[0].path}); ` +
            `${candidates.length - 1} other file(s) define the same name.`,
      scanned,
    };
  }

  if (candidates.length === 1) {
    return {
      name,
      verdict: 'ok',
      definitions: ordered,
      note: `Defined once, in ${ordered[0].path}:${ordered[0].line}.`,
      scanned,
    };
  }

  return {
    name,
    verdict: 'low_confidence',
    definitions: ordered,
    note:
      `${candidates.length} files define "${name}" and name alone cannot distinguish them. ` +
      'Resolution here is by name, not by type, so overloads and interface dispatch are not followed.',
    scanned,
  };
}

/** Same-file candidates first, then by path and line, so the order is stable. */
function orderCandidates(candidates: readonly DefinitionRow[], fromPath?: string): DefinitionRow[] {
  const home = fromPath ? normalisePath(fromPath) : undefined;
  return [...candidates].sort((a, b) => {
    if (home) {
      const aHome = a.path === home ? 0 : 1;
      const bHome = b.path === home ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
    }
    return a.path.localeCompare(b.path) || a.line - b.line;
  });
}

// ------------------------------------------------------------------ bulk edge resolution

/** One resolved edge, in the shape the oracle comparison consumes. */
export interface ResolvedEdge {
  readonly fromPath: string;
  readonly fromLine: number;
  readonly name: string;
  readonly toPath: string;
  readonly toLine: number;
  /**
   * `call` only when exactly one target was identified. An ambiguous call site is
   * `call_reference`, which `isAssertedCall` excludes - so a precision figure computed over
   * asserted calls never silently includes a guess.
   */
  readonly kind: Extract<EdgeKind, 'call' | 'call_reference'>;
}

export interface ResolveEdgesResult {
  readonly edges: readonly ResolvedEdge[];
  readonly counts: {
    /** Call-shaped references considered. */
    readonly callSites: number;
    /** Call sites with exactly one in-repo target. */
    readonly resolved: number;
    /** Call sites with several candidates. */
    readonly ambiguous: number;
    /** Call sites with no in-repo definition - a library call, or a miss. */
    readonly unresolved: number;
    readonly edges: number;
  };
}

/**
 * Resolves every call-shaped reference in the index into edges.
 *
 * Only `call`-kind references are considered: a type annotation is real evidence for *ranking*
 * but it is not a call, and including it here would corrupt a comparison against a call-graph
 * oracle. `usage` edges stay where they belong, in the ranker.
 *
 * `unresolved` is reported rather than hidden. Most of it will be legitimate - calls into
 * `node_modules` and the standard library, which the index does not cover - but the number is
 * also where a systematic extraction gap would show up first, so it must be visible.
 */
export function resolveCallEdges(store: GraphStore): ResolveEdgesResult {
  const edges: ResolvedEdge[] = [];
  let callSites = 0;
  let resolved = 0;
  let ambiguous = 0;
  let unresolved = 0;

  // One pass over the definition table, so each name is looked up once rather than per call site.
  const definitionsByName = new Map<string, DefinitionRow[]>();
  for (const file of store.files()) {
    for (const def of store.definitionsIn(file.path)) {
      let list = definitionsByName.get(def.name);
      if (!list) definitionsByName.set(def.name, (list = []));
      list.push(def);
    }
  }

  for (const file of store.files()) {
    for (const ref of store.referencesIn(file.path)) {
      if (!isAssertedCall(ref.edgeKind)) continue;
      callSites++;

      const candidates = definitionsByName.get(ref.name);
      if (!candidates || candidates.length === 0) {
        unresolved++;
        continue;
      }

      const sameFile = candidates.filter((c) => c.path === file.path);
      if (sameFile.length === 1) {
        resolved++;
        edges.push(edge(file.path, ref.line, ref.name, sameFile[0], 'call'));
        continue;
      }

      if (candidates.length === 1) {
        resolved++;
        edges.push(edge(file.path, ref.line, ref.name, candidates[0], 'call'));
        continue;
      }

      // Ambiguous: emit every candidate, but as `call_reference` so nothing downstream can
      // mistake a guess for a fact.
      ambiguous++;
      for (const candidate of candidates) {
        edges.push(edge(file.path, ref.line, ref.name, candidate, 'call_reference'));
      }
    }
  }

  return {
    edges,
    counts: { callSites, resolved, ambiguous, unresolved, edges: edges.length },
  };
}

function edge(
  fromPath: string,
  fromLine: number,
  name: string,
  to: DefinitionRow,
  kind: ResolvedEdge['kind'],
): ResolvedEdge {
  return { fromPath, fromLine, name, toPath: to.path, toLine: to.line, kind };
}
