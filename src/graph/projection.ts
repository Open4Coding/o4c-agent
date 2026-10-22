/**
 * What the Code Graph says, in the few lines a tool result can afford - build step 4's output
 * side.
 *
 * ## The one place this departs from the design document
 *
 * `0000.DECISION.md` describes step 4 as the index *answering* `grep`/`glob`-class calls, with
 * the four-state verdict making an empty answer honest. On inspection that cannot be done for
 * `grep` and the reason is not a matter of care: **the index holds identifiers, not lines.** It
 * knows that `resolveName` is defined at `resolve.ts:82`; it knows nothing about the same word in
 * a comment, a string literal, a `.md` file, or any file whose language has no bundled grammar.
 * An index-backed `grep` would therefore be a subset of a real one, and `grep` is a tool the
 * model trusts to be exhaustive - so substituting would trade a true answer for a cheaper one.
 *
 * So the graph does not replace a tool's answer here. It answers the *structural* question the
 * model was using `grep` as a proxy for - where is this defined, what kind of thing is it, who
 * calls it - and the real tool's output stands unchanged beside it. The four-state verdict still
 * applies, but to that structural claim, which is a claim the index can actually make.
 *
 * The speed argument for interception does not survive the same inspection and is worth retiring
 * explicitly: nothing here makes `grep_files` faster, because the bytes still have to be read to
 * produce matching lines. What it saves is the *round trips after* the grep - the file reads the
 * model would have spent to find the definition among 200 matching lines.
 *
 * ## Token discipline
 *
 * Every projection is attached to a tool result the model did not ask to have annotated, so it
 * has to earn its tokens: one header line, at most two detail lines, hard caps on every list.
 * `toolHook.ts` drops a projection entirely when it has nothing to say.
 */

import type { DefinitionRow, FileFreshness, GraphStore, ReferenceRow } from './graphStore.js';
import { resolveName, type ResolutionVerdict, type ResolveOptions } from './resolve.js';
import { isAssertedCall } from './edgeKind.js';
import { languageForPath } from './languages.js';

/** Marks a projection as the graph speaking, not the tool. Short because it repeats. */
export const PROJECTION_PREFIX = '[code graph]';

/** Candidate definitions listed before the list is summarised instead. */
const MAX_CANDIDATES_SHOWN = 6;
/** Files whose call sites are listed. Beyond this the count carries the information. */
const MAX_CALL_FILES_SHOWN = 6;
/** Call-site lines listed per file. */
const MAX_LINES_PER_FILE = 4;
/** Definitions listed in a file outline. A 60-definition file needs a count, not a dump. */
const MAX_OUTLINE_DEFINITIONS = 14;

/**
 * Per-file index state as a projection can report it.
 *
 * `unknown` is the extra one: a ranged `read_file` returns a slice, so there are no file bytes to
 * hash and no honest way to claim either `fresh` or `stale`. It prints as no freshness clause at
 * all, which is the only truthful rendering - a guess in either direction is a claim the caller
 * cannot check.
 */
export type ProjectionFreshness = FileFreshness | 'unknown';

export interface NameProjectionOptions extends ResolveOptions {
  /** The file the question came from, if any - it decides the same-file candidate preference. */
  readonly fromPath?: string;
}

/**
 * Where a name is defined and who calls it, with the verdict attached.
 *
 * Always renders, including for `absent` and `degraded`. That is deliberate and the asymmetry
 * matters: when the model *asked* (the `code_graph` tool), "I looked at 171 files and it is not
 * there" is the most useful answer in the set and must never be silently dropped. When the graph
 * is *volunteering* (the `grep_files` annotation), the real tool has already given an exhaustive
 * answer and a note saying the graph has nothing to add is pure cost - so `toolHook.ts` drops
 * those, and the decision lives there rather than being baked in here.
 */
export function renderNameProjection(
  store: GraphStore,
  name: string,
  options: NameProjectionOptions = {},
): string {
  return nameProjection(store, name, options).text;
}

/**
 * The same projection with the verdict alongside it, for callers that have to branch on it.
 *
 * Separate from `renderNameProjection` so no caller has to read the verdict back out of the
 * rendered text. `toolHook.ts` needs it to decide whether a volunteered annotation is worth its
 * tokens, and a regex over our own prose would be a formatting change away from silently wrong.
 */
export function nameProjection(
  store: GraphStore,
  name: string,
  options: NameProjectionOptions = {},
): { readonly verdict: ResolutionVerdict; readonly text: string } {
  const resolution = resolveName(store, name, options.fromPath, options);
  const lines = [`${PROJECTION_PREFIX} ${name} · ${resolution.verdict} · ${resolution.note}`];

  if (resolution.definitions.length > 1) {
    lines.push(`  ${describeCandidates(resolution.definitions)}`);
  }

  // Asserted calls only. A type annotation is evidence for ranking and is not a call site, and
  // labelling one as such here would be the same mistake `edgeKind.ts` exists to prevent.
  const callSites = store.referencesTo(name).filter((r) => isAssertedCall(r.edgeKind));
  if (callSites.length > 0) lines.push(`  ${describeCallSites(callSites)}`);

  return { verdict: resolution.verdict, text: lines.join('\n') };
}

/**
 * What the graph knows about one file: its definitions, and how much of the project points at it.
 *
 * Returns `undefined` when no bundled grammar claims the extension. That is the one case worth
 * staying quiet about: `languages.ts` requires an unparseable file to report `degraded` rather
 * than empty, and that rule is about *answering a question*. Volunteering "I cannot read this"
 * on every `README.md` and `package.json` read would spend tokens on every turn to say nothing.
 * A file the graph *should* have covered and did not still reports, below.
 */
export function renderFileProjection(
  store: GraphStore,
  repoRelativePath: string,
  freshness: ProjectionFreshness,
  options: { readonly indexStatus?: 'fresh' | 'incomplete' } = {},
): string | undefined {
  if (!languageForPath(repoRelativePath)) return undefined;

  if (freshness === 'absent') {
    return (
      `${PROJECTION_PREFIX} ${repoRelativePath} · not indexed · ` +
      (options.indexStatus === 'incomplete'
        ? 'the index is still catching up, so this says nothing about the file.'
        : 'the graph has no definitions for this file - it was excluded as generated, or extraction failed.')
    );
  }

  const definitions = store.definitionsIn(repoRelativePath);
  const state =
    freshness === 'stale' ? ' · index stale' : freshness === 'fresh' ? ' · index fresh' : '';
  const header =
    `${PROJECTION_PREFIX} ${repoRelativePath} · ` +
    `${definitions.length} ${definitions.length === 1 ? 'definition' : 'definitions'}${state}`;

  const lines = [header];
  if (definitions.length > 0) {
    lines.push(`  ${describeOutline(definitions)}`);
    const dependents = dependentFileCount(store, definitions, repoRelativePath);
    if (dependents > 0) {
      lines.push(`  referenced from ${dependents} other ${dependents === 1 ? 'file' : 'files'}`);
    }
  }
  return lines.join('\n');
}

/** `path:line (kind)`, capped. */
function describeCandidates(definitions: readonly DefinitionRow[]): string {
  const shown = definitions
    .slice(0, MAX_CANDIDATES_SHOWN)
    .map((d) => `${d.path}:${d.line} (${d.kind})`);
  const hidden = definitions.length - shown.length;
  return shown.join(' · ') + (hidden > 0 ? ` · +${hidden} more` : '');
}

/** `12 call sites: a.ts:4,9 · b.ts:71`, capped in both directions. */
function describeCallSites(callSites: readonly ReferenceRow[]): string {
  const byFile = new Map<string, number[]>();
  for (const site of callSites) {
    let lines = byFile.get(site.path);
    if (!lines) byFile.set(site.path, (lines = []));
    lines.push(site.line);
  }

  const shown = [...byFile.entries()].slice(0, MAX_CALL_FILES_SHOWN).map(([path, lines]) => {
    const head = lines.slice(0, MAX_LINES_PER_FILE).join(',');
    const rest = lines.length - MAX_LINES_PER_FILE;
    return `${path}:${head}${rest > 0 ? `,+${rest}` : ''}`;
  });
  const hiddenFiles = byFile.size - shown.length;

  const total = `${callSites.length} call ${callSites.length === 1 ? 'site' : 'sites'}`;
  return (
    `${total}: ${shown.join(' · ')}` +
    (hiddenFiles > 0 ? ` · +${hiddenFiles} more ${hiddenFiles === 1 ? 'file' : 'files'}` : '')
  );
}

/** `45 resolveName (function) · 82 ResolvedEdge (interface)`, in line order, capped. */
function describeOutline(definitions: readonly DefinitionRow[]): string {
  const shown = definitions
    .slice(0, MAX_OUTLINE_DEFINITIONS)
    .map((d) => `${d.line} ${d.name} (${d.kind})`);
  const hidden = definitions.length - shown.length;
  return shown.join(' · ') + (hidden > 0 ? ` · +${hidden} more` : '');
}

/**
 * How many other files reference anything this file defines.
 *
 * Counted over all reference kinds, not just calls: for "does anything depend on this file" a
 * type annotation is a genuine dependency, which is exactly the case `referencesTo`'s own comment
 * makes for defaulting to all references in a ranking context.
 */
function dependentFileCount(
  store: GraphStore,
  definitions: readonly DefinitionRow[],
  ownPath: string,
): number {
  const files = new Set<string>();
  const names = new Set(definitions.map((d) => d.name));
  for (const name of names) {
    for (const ref of store.referencesTo(name)) {
      if (ref.path !== ownPath) files.add(ref.path);
    }
  }
  return files.size;
}
