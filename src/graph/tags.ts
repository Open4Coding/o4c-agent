/**
 * Definition and reference extraction - the raw material the ranking engine consumes.
 *
 * This is deliberately the whole of it. The Code Graph's job is to **rank what matters inside a
 * token budget**, not to answer "what calls this function": the externally-graded benchmark in
 * `docs/research/code-graph/18.repowise.md` shows the best tool in the field recovering 32% of a
 * real call graph, and one recovering 2.6%. A `callers` tool over a graph like that is not
 * approximately right, it is silently wrong - the model asks what calls `validateToken`, gets
 * nothing, and deletes it. Personalized PageRank over the same noisy graph degrades gracefully,
 * because its output was never a completeness claim. So: extract tags, rank with them, and never
 * present them as a complete picture.
 */

import { languageForPath } from './languages.js';
import { loadQuery, parserFor, GrammarUnavailableError } from './loadLanguage.js';

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

/**
 * Extracts every definition and reference from one file's source.
 *
 * Throws `GrammarUnavailableError` when the language has no usable grammar. Callers map that to
 * the `degraded` verdict; they must not map it to an empty tag list.
 */
export async function extractTags(source: string, languageId: string): Promise<Tag[]> {
  const parser = await parserFor(languageId);
  const query = await loadQuery(languageId);

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
    return tags;
  } finally {
    // WASM memory is not garbage-collected for us; a tree left undeleted is a leak, and this
    // runs over every file in a repository.
    tree.delete();
  }
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
