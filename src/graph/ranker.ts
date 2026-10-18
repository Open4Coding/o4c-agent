/**
 * The ranking engine - build step 3 of `docs/research/code-graph/0000.DECISION.md`.
 *
 * A reimplementation of aider's `repomap.py` ranking in TypeScript, over the Code Graph's own
 * SQLite store instead of a per-file tag cache. The algorithm is adopted rather than invented
 * because its weighting heuristics are not guessable - they are the product of two years of
 * tuning against real repositories, and the research found no competitor that measured better
 * on the thing that matters.
 *
 * **Where o4c differs from aider, and it is the only interesting difference:** aider seeds
 * personalization from the files a user has explicitly added to the chat. o4c sits inside the
 * front end, so it can seed from live state - the file open in the editor, the files already
 * read this session, identifiers the user just typed. That is the concrete payoff of the
 * core-tier decision (item 38): an MCP server could never see any of it.
 *
 * Verbatim-from-source heuristics, with aider's own reasoning:
 * - x10 for an identifier the user mentioned
 * - x10 for a snake/kebab/camel name of **>= 8 characters** - long multi-word names are
 *   domain-specific, short ones are noise
 * - x0.1 for a leading `_` - private by convention
 * - x0.1 when **more than 5 files** define the same name - `complete`, `constructor`, `execute`
 * - x50 when the *referencing* file is one the user is working in
 * - `sqrt(num_refs)` so a file mentioning a name 400 times does not outweigh everything
 * - a 0.1-weight **self-edge** for a definition nothing references, so an unreferenced file is
 *   still ranked rather than invisible
 */

import type { GraphStore } from './graphStore.js';
import { pageRank, type RankEdge } from './pageRank.js';
import { normalisePath } from './entityId.js';

/** Live front-end state that steers the ranking. All fields optional; all are just hints. */
export interface RankingContext {
  /**
   * Files the user is actively working in - the open editor file, files already in context.
   * Strongly personalized, their outgoing references amplified x50, and **excluded from the
   * output** because their content is already on the wire.
   */
  readonly focusFiles?: readonly string[];
  /** Files named in conversation but not open. Personalized, not excluded. */
  readonly mentionedFiles?: readonly string[];
  /** Identifiers the user mentioned. Multiplies those identifiers' edge weights x10. */
  readonly mentionedIdents?: readonly string[];
}

/** One ranked definition: a file, the identifier that earned it the rank, and the rank. */
export interface RankedDefinition {
  readonly path: string;
  readonly ident: string;
  readonly rank: number;
  readonly line: number;
  readonly kind: string;
}

export interface RankingResult {
  /** Definitions, highest rank first. */
  readonly definitions: readonly RankedDefinition[];
  /** Every file by rank, highest first - including files with no tags at all. */
  readonly files: readonly { path: string; rank: number }[];
  readonly converged: boolean;
  readonly iterations: number;
}

/** aider's `personalize` base: 100 / number of files. */
function personalizeUnit(fileCount: number): number {
  return fileCount > 0 ? 100 / fileCount : 0;
}

/** Path components plus basename with and without extension - what aider matches idents against. */
function pathComponents(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const basename = parts[parts.length - 1] ?? '';
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return [...parts, basename, stem];
}

/**
 * The per-identifier multiplier. Lifted from `repomap.py` with its thresholds intact - 8
 * characters and 5 definitions are tuned constants, not round numbers to taste.
 */
function identMultiplier(ident: string, definerCount: number, mentionedIdents: ReadonlySet<string>): number {
  let mul = 1;

  const hasAlpha = /\p{L}/u.test(ident);
  const isSnake = ident.includes('_') && hasAlpha;
  const isKebab = ident.includes('-') && hasAlpha;
  const isCamel = /\p{Lu}/u.test(ident) && /\p{Ll}/u.test(ident);

  if (mentionedIdents.has(ident)) mul *= 10;
  if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
  if (ident.startsWith('_')) mul *= 0.1;
  if (definerCount > 5) mul *= 0.1;

  return mul;
}

/**
 * Ranks every definition in the store.
 *
 * Reads the whole index into memory once. That is the right shape at this scale - a file-level
 * graph with identifiers is small, and the measured cost of building one over o4c's own source
 * was 80 MB - but it is also why the caller should run this off the UI thread for a large
 * repository, per the worker decision in `0000.DECISION.md`.
 */
export function rankDefinitions(store: GraphStore, context: RankingContext = {}): RankingResult {
  const focus = new Set((context.focusFiles ?? []).map(normalisePath));
  const mentionedFiles = new Set((context.mentionedFiles ?? []).map(normalisePath));
  const mentionedIdents = new Set(context.mentionedIdents ?? []);

  const indexed = store.files();
  const paths = indexed.map((f) => f.path);

  // defines: ident -> defining files. references: ident -> referencing file -> count.
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, Map<string, number>>();
  // (path, ident) -> the definition rows that pair names with a location.
  const definitionSites = new Map<string, { line: number; kind: string }>();

  for (const file of indexed) {
    for (const def of store.definitionsIn(file.path)) {
      let definers = defines.get(def.name);
      if (!definers) defines.set(def.name, (definers = new Set()));
      definers.add(file.path);
      // First declaration of a name in a file wins as its citation site.
      const key = `${file.path}\u0000${def.name}`;
      if (!definitionSites.has(key)) definitionSites.set(key, { line: def.line, kind: def.kind });
    }
    for (const ref of store.referencesIn(file.path)) {
      let counts = references.get(ref.name);
      if (!counts) references.set(ref.name, (counts = new Map()));
      counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
    }
  }

  const unit = personalizeUnit(paths.length);
  const personalization = new Map<string, number>();
  for (const path of paths) {
    let value = 0;
    if (focus.has(path)) value += unit;
    // `max`, not `+`, so a file both focused and mentioned is not counted twice.
    if (mentionedFiles.has(path)) value = Math.max(value, unit);
    if (mentionedIdents.size > 0 && pathComponents(path).some((c) => mentionedIdents.has(c))) {
      value += unit;
    }
    if (value > 0) personalization.set(path, value);
  }

  const edges: RankEdge[] = [];

  // A self-edge for any definition nothing references. Without it an unreferenced file has no
  // edges at all and vanishes from the ranked output, when the honest answer is "low, not none".
  for (const [ident, definers] of defines) {
    if (references.has(ident)) continue;
    for (const definer of definers) {
      edges.push({ from: definer, to: definer, weight: 0.1, ident });
    }
  }

  for (const [ident, definers] of defines) {
    const refCounts = references.get(ident);
    if (!refCounts) continue;

    const mul = identMultiplier(ident, definers.size, mentionedIdents);

    for (const [referencer, count] of refCounts) {
      // A file the user is working in is a far stronger signal about what matters than any
      // other referencer, which is what this multiplier encodes.
      const useMul = focus.has(referencer) ? mul * 50 : mul;
      const scaled = Math.sqrt(count);
      for (const definer of definers) {
        edges.push({ from: referencer, to: definer, weight: useMul * scaled, ident });
      }
    }
  }

  const { ranks, converged, iterations } = pageRank(paths, edges, { personalization });

  // Distribute each node's rank across its out-edges, proportional to weight, accumulating per
  // (definer, ident). This is what turns "which files matter" into "which definitions matter".
  const outTotal = new Map<string, number>();
  for (const edge of edges) outTotal.set(edge.from, (outTotal.get(edge.from) ?? 0) + edge.weight);

  const perDefinition = new Map<string, number>();
  for (const edge of edges) {
    const total = outTotal.get(edge.from) ?? 0;
    if (total <= 0) continue;
    const srcRank = ranks.get(edge.from) ?? 0;
    const key = `${edge.to}\u0000${edge.ident}`;
    perDefinition.set(key, (perDefinition.get(key) ?? 0) + (srcRank * edge.weight) / total);
  }

  const definitions: RankedDefinition[] = [];
  for (const [key, rank] of perDefinition) {
    const sep = key.indexOf('\u0000');
    const path = key.slice(0, sep);
    const ident = key.slice(sep + 1);
    // Files the user already has are excluded: re-sending what is on the wire wastes the budget
    // this whole feature exists to protect.
    if (focus.has(path)) continue;
    const site = definitionSites.get(key);
    if (!site) continue;
    definitions.push({ path, ident, rank, line: site.line, kind: site.kind });
  }

  // Tie-break on path then ident so the output is deterministic - a map that reshuffles between
  // identical runs would invalidate the prompt cache for no reason, which the billing note in
  // `0000.DECISION.md` makes expensive.
  definitions.sort(
    (a, b) => b.rank - a.rank || a.path.localeCompare(b.path) || a.ident.localeCompare(b.ident),
  );

  const files = paths
    .map((path) => ({ path, rank: ranks.get(path) ?? 0 }))
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));

  return { definitions, files, converged, iterations };
}

// ---------------------------------------------------------------------------- budget fitting

/** Renders ranked definitions into the text that will go on the wire. */
export type MapRenderer = (definitions: readonly RankedDefinition[]) => string;

export interface BudgetFitOptions {
  readonly maxTokens: number;
  readonly countTokens: (text: string) => number;
  readonly render?: MapRenderer;
  /** Accepted relative error. aider's `ok_err`; stopping early saves renders. */
  readonly okError?: number;
}

export interface BudgetFitResult {
  readonly text: string;
  readonly tokens: number;
  /** How many ranked definitions fitted. */
  readonly used: number;
  /** Renders performed - the cost of the search, useful when tuning. */
  readonly probes: number;
}

/**
 * Default rendering: one line per file, its ranked identifiers beneath.
 *
 * Deliberately plain. Step 4 decides the shape served through the tool hook; what step 3 owes is
 * a text whose token count is a faithful function of how many definitions were included.
 */
export function renderDefinitionMap(definitions: readonly RankedDefinition[]): string {
  const byFile = new Map<string, RankedDefinition[]>();
  for (const def of definitions) {
    let list = byFile.get(def.path);
    if (!list) byFile.set(def.path, (list = []));
    list.push(def);
  }
  const lines: string[] = [];
  for (const [path, defs] of byFile) {
    lines.push(`${path}:`);
    for (const def of defs) lines.push(`  ${def.line}: ${def.kind} ${def.ident}`);
  }
  return lines.join('\n');
}

/**
 * Binary-searches how many ranked definitions fit a token budget.
 *
 * aider's search, including its two non-obvious choices. The **first probe** is
 * `maxTokens / 25`, not the midpoint - an informed guess at roughly 25 tokens per entry, which
 * usually lands within tolerance immediately and avoids a full search. And it accepts a result
 * within `okError` (0.15) rather than hunting the exact boundary, because each probe costs a
 * render and a token count, and 15% of a map budget is not worth paying for.
 */
export function fitToBudget(
  definitions: readonly RankedDefinition[],
  options: BudgetFitOptions,
): BudgetFitResult {
  const render = options.render ?? renderDefinitionMap;
  const okError = options.okError ?? 0.15;
  const { maxTokens, countTokens } = options;

  if (maxTokens <= 0 || definitions.length === 0) {
    return { text: '', tokens: 0, used: 0, probes: 0 };
  }

  let lower = 0;
  let upper = definitions.length;
  let middle = Math.min(Math.floor(maxTokens / 25), definitions.length);

  let best = { text: '', tokens: 0, used: 0 };
  let probes = 0;

  while (lower <= upper) {
    const text = render(definitions.slice(0, middle));
    const tokens = countTokens(text);
    probes++;

    const pctErr = Math.abs(tokens - maxTokens) / maxTokens;
    if ((tokens <= maxTokens && tokens > best.tokens) || pctErr < okError) {
      best = { text, tokens, used: middle };
      if (pctErr < okError) break;
    }

    if (tokens < maxTokens) lower = middle + 1;
    else upper = middle - 1;

    middle = Math.floor((lower + upper) / 2);
    if (middle < 0) break;
  }

  return { ...best, probes };
}
