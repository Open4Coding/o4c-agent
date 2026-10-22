/**
 * Building the index - the part of the Code Graph that had no caller in the app until now.
 *
 * Steps 1-3 (`tags.ts`, `graphStore.ts`, `ranker.ts`) and the resolver were all driven by
 * `scripts/graph-index.mjs` and the acceptance harness. This is the same walk as product code,
 * so `toolHook.ts` can keep an index current while a session runs.
 *
 * ## Three things it does deliberately
 *
 * **It reuses `walkFiles` from `src/tools/searchUtils.ts`** rather than walking its own way. The
 * graph exists to answer questions about the files `grep_files` and `glob_files` can see, so
 * sharing one walker means the two can never disagree about what the project contains. The cost
 * is that the graph inherits that walker's skip list, which is the right default.
 *
 * **It skips the parse, not the read, when a file is unchanged.** Freshness is a hash of the
 * bytes (`GraphStore.freshness`), so the file has to be read to know. Reading is cheap; the
 * tree-sitter parse is what costs, and that is what gets skipped. A second pass over an unchanged
 * project is therefore I/O-bound rather than CPU-bound - which is what makes it usable at session
 * start on every run instead of only the first.
 *
 * **It releases the grammars after a full pass.** 15 loaded grammars measured at 608 MB resident
 * against 85 MB for three, and the ceiling has to be set from the all-grammars case. A full pass
 * is rare (session start, and after a shell command may have changed anything), so paying the
 * reload is the right side of that trade. `indexSource` does *not* reset, because it runs after
 * every file write and resetting there would reload a grammar per keystroke-sized edit.
 */

import { readFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';

import type { GraphStore } from './graphStore.js';
import { extractFile } from './tags.js';
import { languageForPath } from './languages.js';
import { skipReasonFor, type SkipReason } from './indexFilter.js';
import { resetGrammarCache } from './loadLanguage.js';
import { walkFiles } from '../tools/searchUtils.js';

/**
 * What became of one file.
 *
 * `no-grammar` is separate from every `SkipReason` because it is the one outcome that is not a
 * judgement about the file: nothing is wrong with a `.css` file, the graph simply cannot read it.
 * Collapsing the two would make "we chose not to index this" and "we are unable to" look alike,
 * and only the first licenses reporting an empty result as a fact.
 */
export type FileOutcome = 'indexed' | 'unchanged' | 'no-grammar' | SkipReason | 'failed';

export interface IndexRunResult {
  readonly indexed: number;
  readonly unchanged: number;
  /** Files dropped from the index because they are gone or no longer qualify. */
  readonly removed: number;
  /** Every non-indexing outcome and how often it happened, for `/context` and for diagnosis. */
  readonly outcomes: ReadonlyMap<FileOutcome, number>;
  /** `path: message`, capped - enough to see a pattern without turning a log into a transcript. */
  readonly failures: readonly string[];
  readonly elapsedMs: number;
}

/** Failure messages kept. A systematic problem shows in the first few; a list of 900 does not. */
const MAX_FAILURES_KEPT = 10;

/**
 * Indexes one file's already-read source, returning what became of it.
 *
 * Takes the source rather than reading it, because both callers already hold the bytes: a write
 * has just written them and a read has just read them. That makes keeping the index fresh during
 * a session free of extra I/O, and - more importantly - free of a race, since the bytes indexed
 * are provably the bytes the model saw.
 */
export async function indexSource(
  store: GraphStore,
  repoRelativePath: string,
  source: string,
): Promise<FileOutcome> {
  const language = languageForPath(repoRelativePath);
  if (!language) return 'no-grammar';

  const skip = skipReasonFor(repoRelativePath, source);
  if (skip) {
    // A file that used to qualify and no longer does must leave the index, or a shrinking file
    // would keep answering from stale rows.
    store.removeFile(repoRelativePath);
    return skip;
  }

  if (store.freshness(repoRelativePath, source) === 'fresh') return 'unchanged';

  const { tags, imports } = await extractFile(source, language.id);
  store.indexFile({ path: repoRelativePath, language: language.id, source, tags, imports });
  return 'indexed';
}

/**
 * Walks `root` and brings the index in line with it, then releases the grammars.
 *
 * Returns counts rather than throwing on a per-file failure: one unreadable file in a tree of
 * nine hundred is not a reason to have no index. A failure that matters shows up as a count and a
 * sample, which is also how it stays visible instead of being swallowed.
 */
export interface IndexProjectOptions {
  /**
   * Test seam, not overridden in production - the same arrangement `src/mcp/startup.ts` uses.
   *
   * It exists because the per-file failure path is otherwise unreachable from a test: every
   * portable way to make a read fail (a directory in a file's place, a dangling symlink, a
   * permission bit) is filtered out by `walkFiles` before this code sees it or does not work on
   * Windows. Defensive code with no test is how the defence stops working.
   */
  readonly readSource?: (absolutePath: string) => Promise<string>;
}

export async function indexProject(
  store: GraphStore,
  root: string,
  options: IndexProjectOptions = {},
): Promise<IndexRunResult> {
  const read = options.readSource ?? ((path: string) => readFile(path, 'utf-8'));
  const started = Date.now();
  const outcomes = new Map<FileOutcome, number>();
  const failures: string[] = [];
  let indexed = 0;
  let unchanged = 0;

  const note = (outcome: FileOutcome): void => {
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  };

  const seen = new Set<string>();
  const entries = await walkFiles(root);

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // Cheapest test first: most files in a mixed tree have no bundled grammar, and answering
    // that costs a string comparison rather than a read.
    if (!languageForPath(entry.path)) {
      note('no-grammar');
      continue;
    }

    let source: string;
    try {
      source = await read(join(root, entry.path));
    } catch (err) {
      // Left out of `seen`, so the sweep below drops whatever the index still holds for it. A
      // read can fail because the file was deleted between the walk and the read, and serving
      // definitions from a file that no longer exists is the one error the model cannot detect.
      note('failed');
      if (failures.length < MAX_FAILURES_KEPT) failures.push(`${entry.path}: ${message(err)}`);
      continue;
    }

    try {
      const outcome = await indexSource(store, entry.path, source);
      if (outcome === 'indexed') {
        indexed++;
        seen.add(entry.path);
      } else if (outcome === 'unchanged') {
        unchanged++;
        seen.add(entry.path);
      } else {
        note(outcome);
      }
    } catch (err) {
      // Kept in `seen`, unlike a read failure. The read succeeded, so the file is there and it is
      // the *parse* that failed - and whatever the index already holds for it is then an honestly
      // stale record, which `freshness` will report as `stale` and the verdict will carry. That
      // is strictly more useful than throwing it away, and it is the difference between "I cannot
      // parse this today" and "this file is gone".
      seen.add(entry.path);
      note('failed');
      if (failures.length < MAX_FAILURES_KEPT) failures.push(`${entry.path}: ${message(err)}`);
    }
  }

  // Anything the index still holds that this walk did not account for is gone, renamed, or now
  // excluded. Leaving it would serve definitions from a file that no longer exists, which is the
  // one failure the model has no way to detect.
  let removed = 0;
  for (const file of store.files()) {
    if (!seen.has(file.path)) {
      store.removeFile(file.path);
      removed++;
    }
  }

  resetGrammarCache();

  return { indexed, unchanged, removed, outcomes, failures, elapsedMs: Date.now() - started };
}

/**
 * A tool's `path` argument as a repo-relative index key, or `undefined` if it is outside the root.
 *
 * Outside the root is not an error to report: the file is genuinely none of the graph's business,
 * and the right response is to say nothing about it rather than to index someone's home directory
 * because a path escaped with `../`.
 */
export function repoRelative(root: string, path: string): string | undefined {
  if (!path) return undefined;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split('\\').join('/');
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 120);
}
