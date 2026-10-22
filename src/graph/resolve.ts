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
 * Resolution is by **name**, plus one piece of structural evidence: what the referencing file
 * imported (step 5, `imports.ts`). It is still not by *type*. Overloads, interface dispatch,
 * generics and anything reached through a value are invisible. lidx's compiler-graded diagnostics put bare-name
 * resolution precision at 0.86 for Go, 0.82 for TypeScript and 0.48 for Rust
 * (`docs/research/code-graph/0001.INDEPENDENT-GRADING.md` §4), and bare-name matching is exactly
 * what happens here. That is the reason ambiguity gets its own edge kind rather than a guess.
 *
 * ## The order evidence is weighed
 *
 * 1. **A definition in the referencing file.** Lexical scope is what the language itself would
 *    pick, and the acceptance measurement scored this 1,782 right to 19 wrong.
 * 2. **An import statement naming one candidate.** Added in step 5.
 * 3. **A single candidate in the whole index.**
 *
 * Nothing below that resolves. Import evidence is used only to *choose* among candidates, never
 * to rule one out - see the header of `imports.ts` for why that asymmetry is not laziness.
 */

import type { DefinitionRow, GraphStore } from './graphStore.js';
import { isAssertedCall, type EdgeKind } from './edgeKind.js';
import { normalisePath } from './entityId.js';
import { importedTarget, type ImportBinding } from './imports.js';

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

  // Several candidates and no same-file definition: ask what this file imported. This is the
  // step-5 addition, and it is the only thing standing between a correct answer and a declined
  // one for four fifths of the misses the acceptance measurement found.
  const viaImport = home ? importedCandidate(store, home, name, candidates) : undefined;
  if (viaImport) {
    return {
      name,
      verdict: 'ok',
      definitions: [viaImport.definition, ...ordered.filter((d) => d !== viaImport.definition)],
      note:
        `Imported from "${viaImport.module}", which is ${viaImport.definition.path}:` +
        `${viaImport.definition.line}. ${candidates.length - 1} other file(s) define the same name.`,
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

/** A candidate an import statement singles out, with the specifier that did it. */
interface ImportedCandidate {
  readonly definition: DefinitionRow;
  readonly module: string;
}

/**
 * The candidate the importing file's own import statement names, if it names exactly one.
 *
 * Two files can satisfy the same specifier only in the narrow sense that `./host` could be
 * `host.ts` or `host.js`; `importedTarget` orders those and takes the first. What this *does*
 * decline is a target file holding **several** definitions of the name - a function and a type of
 * the same name, say. The import settles the file but not the line, and a line is what a caller
 * is about to be handed, so the honest answer there is still `low_confidence`.
 */
function importedCandidate(
  store: GraphStore,
  fromPath: string,
  name: string,
  candidates: readonly DefinitionRow[],
): ImportedCandidate | undefined {
  const module = store.importedModule(fromPath, name);
  if (!module) return undefined;

  const target = importedTarget(fromPath, module, candidates.map((c) => c.path));
  if (!target) return undefined;

  const inTarget = candidates.filter((c) => c.path === target);
  return inTarget.length === 1 ? { definition: inTarget[0], module } : undefined;
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
    /**
     * Of the resolved ones, how many only resolved because of an import statement.
     *
     * Reported so the step-5 change can be judged rather than assumed: this number is exactly
     * the set of answers that would have been declined as ambiguous before it.
     */
    readonly viaImport: number;
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
  let viaImport = 0;

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
    // One query per file rather than one per call site: a file with 200 calls asks about its own
    // imports once.
    const imports = importMap(store.importsIn(file.path));

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

      const module = candidates.length > 1 ? imports.get(ref.name) : undefined;
      const target = module
        ? importedTarget(file.path, module, candidates.map((c) => c.path))
        : undefined;
      if (target) {
        const inTarget = candidates.filter((c) => c.path === target);
        if (inTarget.length === 1) {
          resolved++;
          viaImport++;
          edges.push(edge(file.path, ref.line, ref.name, inTarget[0], 'call'));
          continue;
        }
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
    counts: { callSites, resolved, ambiguous, unresolved, viaImport, edges: edges.length },
  };
}

/**
 * One file's import bindings as `local name -> module`.
 *
 * A name bound to two different modules in one file is dropped rather than resolved to either.
 * That is not legal TypeScript in a single scope, so it means something has gone wrong - a
 * generated file, or an index that is mid-update - and the one thing import evidence must not do
 * is guess.
 */
function importMap(bindings: readonly ImportBinding[]): Map<string, string> {
  const map = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const binding of bindings) {
    const existing = map.get(binding.localName);
    if (existing !== undefined && existing !== binding.module) conflicted.add(binding.localName);
    else map.set(binding.localName, binding.module);
  }
  for (const name of conflicted) map.delete(name);
  return map;
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
