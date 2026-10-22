/**
 * Definition and reference extraction - the raw material the ranking engine consumes.
 *
 * This is deliberately the whole of it. The Code Graph's job is to **rank what matters inside a
 * token budget**, not to answer "what calls this function". The externally-graded benchmark in
 * `docs/research/code-graph/18.repowise.md` reports call-graph recall ranging from 0.026 to 0.967
 * across repositories, and its author explicitly forbids comparing cells across rows - so the
 * usable finding there is the **variance**, not any single figure, and nothing is available at
 * query time to say which end of the range you are at. A `callers` tool answering over a graph
 * like that is not approximately right, it is silently wrong: the model asks what calls
 * `validateToken`, gets nothing, and deletes it. Personalized PageRank over the same noisy graph
 * degrades gracefully, because its output was never a completeness claim. So: extract tags, rank
 * with them, and never present them as a complete picture.
 *
 * What *this* extractor manages is measured rather than estimated, in
 * `.docs/code-graph-acceptance.md`: graded against the TypeScript compiler, 99.4-99.7% precision
 * and 81.8-92.6% recall over plain and member call sites with in-repo targets. That is one
 * language at the call shapes the queries claim, and it says nothing about the other fourteen.
 */

import { languageForPath } from './languages.js';
import { loadQuery, loadImportQuery, parserFor, GrammarUnavailableError } from './loadLanguage.js';
import { collectImports, type ImportBinding } from './imports.js';

/** Whether an occurrence defines a name or merely mentions one. */
export type TagKind = 'def' | 'ref';

/** One captured name in one file. */
export interface Tag {
  /** The identifier text, e.g. `computeArea`. */
  readonly name: string;
  readonly kind: TagKind;
  /**
   * The full capture name, e.g. `name.definition.function` or `name.reference.method`. Kept
   * because it is the only record of *what sort* of definition this was, and discarding it now
   * would mean re-parsing later to recover it.
   */
  readonly capture: string;
  /** 1-based line, for citation and display only - never for identity. Line numbers drift. */
  readonly line: number;
}

/**
 * Captures split into definitions and references by **prefix**, never by exact capture name.
 *
 * This matters more than it looks. The tree-sitter documentation describes eight standard
 * capture names, and real query files do not honour it: Java emits `@name.reference.method` for
 * an invocation where JavaScript, Python, Go and Rust emit `@name.reference.call`. Keying on
 * exact names silently yields zero references for Java - which is exactly what happened while
 * building this, and the first probe reported it as a Java failure before the queries turned out
 * to be fine. Aider keys on the prefix for the same reason (`repomap.py:319-322`).
 */
const DEFINITION_PREFIX = 'name.definition.';
const REFERENCE_PREFIX = 'name.reference.';

/** Everything one parse of one file yields. */
export interface FileExtraction {
  readonly tags: readonly Tag[];
  /** Empty for a language with no import query, which is most of them. */
  readonly imports: readonly ImportBinding[];
}

/**
 * Extracts every definition, reference and import binding from one file's source.
 *
 * One parse for all three. The tag query and the import query are separate files - see
 * `grammarPaths.ts` for why - but running them over two trees would double the cost of the only
 * expensive step in an index pass for no gain whatsoever.
 *
 * Throws `GrammarUnavailableError` when the language has no usable grammar. Callers map that to
 * the `degraded` verdict; they must not map it to an empty result.
 */
export async function extractFile(source: string, languageId: string): Promise<FileExtraction> {
  const parser = await parserFor(languageId);
  const query = await loadQuery(languageId);
  const importQuery = await loadImportQuery(languageId);

  const tree = parser.parse(source);
  if (!tree) throw new GrammarUnavailableError(languageId, new Error('parser returned no tree'));

  try {
    const tags: Tag[] = [];
    for (const capture of query.captures(tree.rootNode)) {
      const kind: TagKind | undefined = capture.name.startsWith(DEFINITION_PREFIX)
        ? 'def'
        : capture.name.startsWith(REFERENCE_PREFIX)
          ? 'ref'
          : undefined;
      if (!kind) continue; // Outer `@definition.*`/`@reference.*` captures wrap the whole node.

      tags.push({
        name: capture.node.text,
        kind,
        capture: capture.name,
        line: capture.node.startPosition.row + 1,
      });
    }
    return {
      tags,
      imports: importQuery ? collectImports(tree.rootNode, importQuery) : [],
    };
  } finally {
    // WASM memory is not garbage-collected for us; a tree left undeleted is a leak, and this
    // runs over every file in a repository.
    tree.delete();
  }
}

/**
 * Just the tags, for the callers that have no use for import bindings - the ranker's fixtures and
 * the per-grammar load test among them.
 */
export async function extractTags(source: string, languageId: string): Promise<Tag[]> {
  return [...(await extractFile(source, languageId)).tags];
}

/**
 * `extractTags` for a path, choosing the language by extension.
 *
 * Returns `undefined` when no bundled grammar claims the extension. That is a third state and
 * not an empty result: the caller knows the difference between "parsed, found nothing" and "no
 * parser, cannot say".
 */
export async function extractTagsForPath(source: string, path: string): Promise<Tag[] | undefined> {
  const language = languageForPath(path);
  if (!language) return undefined;
  return extractTags(source, language.id);
}

/**
 * `extractFile` for a path, with the same third state as `extractTagsForPath`.
 *
 * For the indexing scripts, which build a store the resolver will be measured over and so must
 * record imports as well as tags - a script that indexed only tags would make the measurement
 * silently report the pre-step-5 behaviour.
 */
export async function extractFileForPath(
  source: string,
  path: string,
): Promise<FileExtraction | undefined> {
  const language = languageForPath(path);
  if (!language) return undefined;
  return extractFile(source, language.id);
}
