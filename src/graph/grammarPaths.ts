/**
 * Where the bundled grammars and tag queries live, and how to point somewhere else.
 *
 * This indirection is not optional. o4c ships as a built `dist/` and `tsc` copies neither
 * `.wasm` nor `.scm`, so the assets sit at the repository root in `grammars/` and travel via
 * package.json's `files`. Resolving them relative to this module works identically from
 * `src/graph/` under `tsx` and from `dist/graph/` after a build, because both are two levels
 * below the root.
 *
 * `repomix` reached the same conclusion from the same constraint and exposes it as
 * `setWasmBasePath()` / `REPOMIX_WASM_DIR` - see `docs/research/code-graph/31.repomix.md`.
 * Here the override doubles as the supported route to languages outside the bundled set:
 * drop further `wasm/tree-sitter-<id>.wasm` and `queries/<id>.scm` into a directory and name
 * it. That keeps the install small without ever fetching anything, which matters because
 * fetching is egress and secure mode forbids egress.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Points the loader at a different grammar directory. Takes precedence over the default. */
export const GRAMMAR_DIR_ENV = 'O4C_WASM_DIR';

let overrideDir: string | undefined;

/** The bundled `grammars/` directory - two levels up from `src/graph/` or `dist/graph/`. */
function bundledGrammarDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars');
}

/**
 * Overrides the grammar directory for the rest of the process, or clears the override with
 * `undefined`. Set before the first load; grammars already loaded are cached and will not move.
 */
export function setGrammarDir(dir: string | undefined): void {
  overrideDir = dir;
}

/**
 * The directory in force: an explicit `setGrammarDir`, else `O4C_WASM_DIR`, else the bundled
 * assets. The env var is read on every call rather than once at import, so a test can set it
 * without depending on module load order.
 */
export function grammarDir(): string {
  return overrideDir ?? process.env[GRAMMAR_DIR_ENV] ?? bundledGrammarDir();
}

/** Absolute path to a language's compiled parser. */
export function wasmPathFor(languageId: string): string {
  return join(grammarDir(), 'wasm', `tree-sitter-${languageId}.wasm`);
}

/** Absolute path to a language's tag query. */
export function queryPathFor(languageId: string): string {
  return join(grammarDir(), 'queries', `${languageId}.scm`);
}

/**
 * Absolute path to a language's **import** query, which most languages do not have.
 *
 * Separate from the tag query because the two answer different questions, and because the tag
 * queries carry measured precision figures that an unrelated edit should not put back in play -
 * see the header of `typescript.imports.scm`. A missing file is the normal case and means "this
 * language contributes no import bindings", never an error.
 */
export function importQueryPathFor(languageId: string): string {
  return join(grammarDir(), 'queries', `${languageId}.imports.scm`);
}
