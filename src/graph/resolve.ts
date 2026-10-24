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
import { languageById, languageForPath } from './languages.js';

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
  const home = fromPath ? normalisePath(fromPath) : undefined;
  const chosen = chooseTarget(candidates, {
    fromPath: home,
    importedModule: home ? store.importedModule(home, name) : undefined,
  });

  if (!chosen) {
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

  return {
    name,
    verdict: 'ok',
    // The chosen definition first; the rest stay in the list, because the verdict is a claim
    // about one candidate and not a deletion of the others.
    definitions: [chosen.definition, ...ordered.filter((d) => d !== chosen.definition)],
    note: noteFor(chosen, candidates.length),
    scanned,
  };
}

function noteFor(chosen: ChosenTarget, candidateCount: number): string {
  const others = candidateCount - 1;
  switch (chosen.route) {
    case 'unique':
      return `Defined once, in ${chosen.definition.path}:${chosen.definition.line}.`;
    case 'same-file':
      return others === 0
        ? `Defined once, in ${chosen.definition.path}.`
        : `Defined in the referencing file (${chosen.definition.path}); ` +
          `${others} other file(s) define the same name.`;
    case 'import':
      return (
        `Imported from "${chosen.module}", which is ${chosen.definition.path}:` +
        `${chosen.definition.line}. ${others} other file(s) define the same name.`
      );
    case 'call-shape':
      return (
        `${chosen.definition.path}:${chosen.definition.line} is the only ${chosen.definition.kind} ` +
        `of this name, and the reference is a ${chosen.shape === 'member' ? 'method' : 'plain'} call. ` +
        `${others} other file(s) define the same name.`
      );
    case 'callable':
      return (
        `${chosen.definition.path}:${chosen.definition.line} is the only definition a call can reach; ` +
        `${others} other ${others === 1 ? 'definition is a type' : 'definitions are types'} of the same name.`
      );
  }
}

// ------------------------------------------------------------------ the one choice ladder

/**
 * Which rule picked a target. Tried in this order, and reported so a measurement can weigh each
 * rule separately rather than crediting the ladder as a whole.
 */
export type ResolutionRoute = 'callable' | 'call-shape' | 'same-file' | 'import' | 'unique';

/** `f()` versus `o.f()` - only known for a language whose query distinguishes them. */
export type CallShape = 'bare' | 'member';

export interface ChosenTarget {
  readonly definition: DefinitionRow;
  readonly route: ResolutionRoute;
  /** The specifier that settled it. `route: 'import'` only. */
  readonly module?: string;
  /** The shape that narrowed the field. `route: 'call-shape'` only. */
  readonly shape?: CallShape;
}

export interface ChooseOptions {
  /** The referencing file, already normalised. */
  readonly fromPath?: string;
  /** The specifier this file imported the name from, if it did and if it did so once. */
  readonly importedModule?: string;
  /** The call site's shape, when the language's query records it. */
  readonly callShape?: CallShape;
  /**
   * The reference is known to be a call, so a type-only candidate cannot be its target. Not set
   * for a bare name question (`resolveName`): there the name may be used as a type, and choosing
   * the function would be a claim the index cannot back.
   */
  readonly isCall?: boolean;
}

/**
 * The one target the available evidence singles out, or `undefined` to decline.
 *
 * Deliberately pure - no store, no I/O - so that `resolveName` (the model's question) and
 * `resolveCallEdges` (the graded measurement) cannot drift apart. They used to carry two copies
 * of this ladder, which meant the acceptance figures were measured over code the product did not
 * quite run.
 *
 * Every rule here is **positive**: each may choose among the candidates the index already holds,
 * and none may rule a candidate out. The type-only and call-shape narrowings therefore fall back
 * to the full list when they would empty it, and a missing or unknown shape narrows nothing.
 */
export function chooseTarget(
  candidates: readonly DefinitionRow[],
  options: ChooseOptions = {},
): ChosenTarget | undefined {
  if (candidates.length === 0) return undefined;

  const callable = options.isCall ? narrowToCallable(candidates) : candidates;
  const narrowed = narrowByCallShape(callable, options.callShape);
  if (narrowed.length === 1) {
    if (narrowed.length === candidates.length) return { definition: narrowed[0], route: 'unique' };
    return callable.length === 1
      ? { definition: narrowed[0], route: 'callable' }
      : { definition: narrowed[0], route: 'call-shape', shape: options.callShape };
  }

  // A same-file definition is treated as decisive even when others share the name, because
  // lexical scope means that is what the language itself would pick. Measured across both graded
  // repositories at 1,860 right to 19 wrong.
  const home = options.fromPath;
  if (home) {
    const sameFile = narrowed.filter((c) => c.path === home);
    if (sameFile.length === 1) return { definition: sameFile[0], route: 'same-file' };
  }

  // What did this file import? See `imports.ts` - positive evidence only.
  if (home && options.importedModule) {
    const target = importedTarget(home, options.importedModule, narrowed.map((c) => c.path));
    if (target) {
      const inTarget = narrowed.filter((c) => c.path === target);
      // A target file holding *several* definitions of the name - a function and a type, say -
      // settles the file but not the line, and a line is what the caller is about to be handed.
      if (inTarget.length === 1) {
        return { definition: inTarget[0], route: 'import', module: options.importedModule };
      }
    }
  }

  return undefined;
}

/**
 * Candidates whose kind the call's syntax can actually reach, or all of them when that would
 * leave none.
 *
 * Exactly one kind is excluded per shape, and only where the exclusion is a fact about the
 * language rather than a heuristic:
 *
 * - `o.f()` cannot reach a top-level `function` - a declaration or a `const` arrow is not a
 *   member of anything. (`import * as ns` is the exception, and it costs a decline rather than a
 *   wrong answer, because this rule only ever removes candidates from a contested list.)
 * - `f()` cannot reach a `method` without a receiver.
 *
 * A `field` - a function held in a property or a parameter - is reachable **either** way and is
 * therefore never excluded. Getting that third kind wrong is not theoretical: while those were
 * filed under `function`, the first version of this rule resolved `confirmDialog.resolve(...)` to
 * an unrelated `async resolve()` in another file, nine times in one cell. See the note in
 * `typescript.scm`.
 *
 * The fallback to the full list is what keeps the rule positive, and a language whose query does
 * not distinguish the two shapes passes `undefined` and narrows nothing.
 */
function narrowToCallable(candidates: readonly DefinitionRow[]): readonly DefinitionRow[] {
  const kept = candidates.filter(isCallable);
  return kept.length > 0 ? kept : candidates;
}

/**
 * Whether any call could reach this definition. False only for a kind the file's language marks
 * type-only (`languages.ts`), so a `type X = any` stub sharing a function's name stops making the
 * function's every call site unattributable. That stub is not hypothetical: a 2,782-file
 * repository measured on 2026-10-24 carries 747 files of them, and one sent a "who calls this"
 * question on it back to grep and file reads.
 */
export function isCallable(definition: DefinitionRow): boolean {
  return !languageForPath(definition.path)?.typeOnlyKinds?.includes(definition.kind);
}

function narrowByCallShape(
  candidates: readonly DefinitionRow[],
  shape: CallShape | undefined,
): readonly DefinitionRow[] {
  if (!shape) return candidates;
  const unreachable = shape === 'member' ? 'function' : 'method';
  const kept = candidates.filter((c) => c.kind !== unreachable);
  return kept.length > 0 ? kept : candidates;
}

/**
 * The call shape a stored reference kind implies, or `undefined` when the language's query does
 * not distinguish.
 *
 * Gated on the language rather than on the kind alone, because `method` means "an invocation" in
 * Java's query and "an invocation through a member expression" in the ECMAScript ones. Reading
 * the ECMAScript meaning into a Java reference would narrow by a distinction that query never
 * made.
 */
export function callShapeFor(languageId: string, referenceKind: string): CallShape | undefined {
  if (!languageById(languageId)?.distinguishesCallShape) return undefined;
  if (referenceKind === 'method') return 'member';
  return referenceKind === 'call' ? 'bare' : undefined;
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
    /**
     * Of the resolved ones, how many only resolved because the call's shape ruled the others out.
     *
     * Same purpose as `viaImport`, for the step-6 change: these are answers that were declined as
     * ambiguous while `f()` and `o.f()` were stored identically.
     */
    readonly viaCallShape: number;
    /**
     * Of the resolved ones, how many only resolved because every other candidate was a type no
     * call can reach. Same purpose again, for the type-only change.
     */
    readonly viaCallable: number;
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
  let viaCallShape = 0;
  let viaCallable = 0;

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

      const chosen = chooseTarget(candidates, {
        fromPath: file.path,
        importedModule: imports.get(ref.name),
        callShape: callShapeFor(file.language, ref.kind),
        isCall: true,
      });

      if (chosen) {
        resolved++;
        if (chosen.route === 'import') viaImport++;
        if (chosen.route === 'call-shape') viaCallShape++;
        if (chosen.route === 'callable') viaCallable++;
        edges.push(edge(file.path, ref.line, ref.name, chosen.definition, 'call'));
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
    counts: {
      callSites,
      resolved,
      ambiguous,
      unresolved,
      viaImport,
      viaCallShape,
      viaCallable,
      edges: edges.length,
    },
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
