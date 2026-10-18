/**
 * Lazy, cached loading of tree-sitter grammars and their tag queries.
 *
 * `web-tree-sitter` is pure WebAssembly, which is the entire reason it is the parser here: the
 * native binding would mean one native package per language and a node-gyp build or a prebuilt
 * binary per platform, ending design doc 9.2's "85 packages, zero native modules" in one commit.
 * Two Node projects in the research set - Graft and claude-context - chose the native binding
 * instead. See `docs/research/code-graph/01.tree-sitter.md`.
 *
 * Everything here is lazy and cached. A language the user never opens costs nothing beyond the
 * bytes on disk, and a language opened a thousand times is loaded once. Measured on this machine
 * at first load: 1-5 ms per grammar, 0.4-4.8 ms to parse a small file.
 *
 * The published version is pinned deliberately. The `tree-sitter` clone in `research/` carries
 * `web-tree-sitter` 0.28.0, which is **unreleased** - the latest on npm is 0.27.1, which is also
 * what repomix depends on.
 */

import { readFile } from 'node:fs/promises';
import { Parser, Language, Query } from 'web-tree-sitter';
import { languageById } from './languages.js';
import { wasmPathFor, queryPathFor } from './grammarPaths.js';

/**
 * A grammar or query could not be loaded.
 *
 * Callers must translate this into the `degraded` verdict and never into an empty result: "no
 * parser for this language" must not be allowed to read as "this file defines nothing". This
 * path is reachable under every grammar-shipping policy, since no payload covers every language
 * that exists - bundling more grammars makes it rarer, not absent.
 */
export class GrammarUnavailableError extends Error {
  constructor(
    readonly languageId: string,
    readonly cause: unknown,
  ) {
    super(`No usable grammar for "${languageId}": ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'GrammarUnavailableError';
  }
}

/** `Parser.init()` is process-wide and must happen once; concurrent callers share the promise. */
let initPromise: Promise<void> | undefined;

const languages = new Map<string, Promise<Language>>();
const queries = new Map<string, Promise<Query>>();
const parsers = new Map<string, Parser>();

/** Initialises the WASM runtime. Idempotent, and safe to call concurrently. */
export async function initParser(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

/** Loads (or returns the cached) grammar for a language id. */
export async function loadLanguage(languageId: string): Promise<Language> {
  const cached = languages.get(languageId);
  if (cached) return cached;

  const loading = (async () => {
    await initParser();
    return Language.load(wasmPathFor(languageId));
  })().catch((err: unknown) => {
    // A failed load must not poison the cache - a later call with a corrected O4C_WASM_DIR
    // should be able to succeed.
    languages.delete(languageId);
    throw new GrammarUnavailableError(languageId, err);
  });

  languages.set(languageId, loading);
  return loading;
}

/** Loads (or returns the cached) tag query for a language id. */
export async function loadQuery(languageId: string): Promise<Query> {
  const cached = queries.get(languageId);
  if (cached) return cached;

  const loading = (async () => {
    const language = await loadLanguage(languageId);
    const source = await readFile(queryPathFor(languageId), 'utf-8');
    return new Query(language, source);
  })().catch((err: unknown) => {
    queries.delete(languageId);
    throw err instanceof GrammarUnavailableError ? err : new GrammarUnavailableError(languageId, err);
  });

  queries.set(languageId, loading);
  return loading;
}

/**
 * A parser with this language already set, reused across calls.
 *
 * One parser per language rather than one per call: parsing is synchronous once the grammar is
 * loaded, and Node is single-threaded, so there is no window in which two callers hold the same
 * parser mid-parse. Trees are a different matter - see `extractTags`, which deletes every tree
 * it creates. WASM memory is not garbage-collected for us.
 */
export async function parserFor(languageId: string): Promise<Parser> {
  const cached = parsers.get(languageId);
  if (cached) return cached;

  const language = await loadLanguage(languageId);
  const parser = new Parser();
  parser.setLanguage(language);
  parsers.set(languageId, parser);
  return parser;
}

/** True when this language id is in the bundled set. Says nothing about the file existing. */
export function isKnownLanguage(languageId: string): boolean {
  return languageById(languageId) !== undefined;
}

/**
 * Drops every cached grammar, query and parser and frees their WASM memory.
 *
 * For tests that switch grammar directory, and for a future reindex that wants the memory back.
 * `Parser.init()` is not undone - it is process-wide and re-initialising is neither needed nor
 * supported.
 */
export function resetGrammarCache(): void {
  for (const parser of parsers.values()) parser.delete();
  parsers.clear();
  for (const query of queries.values()) void query.then((q) => q.delete()).catch(() => {});
  queries.clear();
  languages.clear();
}
