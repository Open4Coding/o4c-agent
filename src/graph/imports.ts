/**
 * Import bindings, and what they let the resolver decide.
 *
 * This is build step 5's first half, and it exists because the acceptance measurement said so
 * rather than because it seemed like a good idea. Of the 547 misses in the largest graded cell,
 * **461 (84.3%) had the correct target sitting in the candidate list and were declined** because
 * the name alone could not choose between files defining it. `.docs/code-graph-acceptance.md`
 * named the fix in one sentence: if `startup.ts` calls `start()` and imports `start` from
 * `./host`, the name is no longer ambiguous.
 *
 * ## Positive evidence only
 *
 * An import is used **to choose among candidates the index already holds**, never to rule a
 * candidate out. The asymmetry is deliberate, and it is about the one thing this module cannot
 * do reliably: a specifier that does not start with `.` *usually* means a package, but it can
 * also be a `tsconfig` path alias (`@/foo`) or a `baseUrl` import, both of which are in-repo. If
 * import evidence were allowed to say "this name comes from outside, so the in-repo candidate is
 * wrong", every aliased import in a project configured that way would turn a correct answer into
 * a declined one - or worse, into a confidently wrong `absent`. Used positively, the worst a
 * misread specifier can do is fail to help.
 *
 * That also means this module never needs `tsconfig.json`, never resolves through
 * `node_modules`, and never touches the filesystem. It computes the handful of repo-relative
 * paths a specifier *could* name and intersects them with the candidate list. Nothing to stat,
 * nothing to race with.
 *
 * ## What it does not follow
 *
 * **Re-exports.** `export { start } from './host'` creates no local binding, and an
 * `import { start } from './index.js'` against a barrel file resolves to `index.ts`, which
 * defines nothing of that name - so the match simply fails and the reference stays ambiguous.
 * One hop of re-export following would fix that; whether it is worth the complexity is a
 * question for the next measurement, not a guess to make here.
 *
 * **`require()` and dynamic `import()`.** No query pattern captures them.
 */

import { posix } from 'node:path';

import type { Node, Query } from 'web-tree-sitter';

import { normalisePath } from './entityId.js';

/** One local name and the module it came from. */
export interface ImportBinding {
  /** The name the importing file uses - the alias when there is one, never the original. */
  readonly localName: string;
  /** The specifier exactly as written: `./host`, `../graph/store.js`, `node:path`, `react`. */
  readonly module: string;
  /** 1-based line of the import statement, for citation only. */
  readonly line: number;
}

const NAME_CAPTURE = 'name.import';
const MODULE_CAPTURE = 'module.import';

/**
 * Collects import bindings from an already-parsed tree.
 *
 * Takes a node and a query rather than source and a language id, so the caller can run this on
 * the same tree it extracted tags from. Parsing twice to learn two things about one file would
 * double the cost of a cold index pass for no gain.
 *
 * A match missing either capture is skipped rather than guessed at: that can only happen if a
 * query file is edited into a shape this code does not expect, and half an import binding is
 * worse than none.
 */
export function collectImports(root: Node, query: Query): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const match of query.matches(root)) {
    let localName: string | undefined;
    let module: string | undefined;
    let line = 0;
    for (const capture of match.captures) {
      if (capture.name === NAME_CAPTURE) {
        localName = capture.node.text;
        line = capture.node.startPosition.row + 1;
      } else if (capture.name === MODULE_CAPTURE) {
        module = capture.node.text;
      }
    }
    if (localName && module) bindings.push({ localName, module, line });
  }
  return bindings;
}

/** Whether a specifier names a path rather than a package. */
export function isRelativeSpecifier(module: string): boolean {
  return module.startsWith('./') || module.startsWith('../') || module === '.' || module === '..';
}

/**
 * Extensions a module specifier may carry that are **not** the extension of the file on disk.
 *
 * TypeScript under `NodeNext` requires the emitted extension in the specifier, so this
 * repository is full of `./graphStore.js` imports that mean `graphStore.ts`. A resolver that
 * took the specifier's extension literally would miss every single one of them.
 */
const REWRITTEN_EXTENSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', ['.ts', '.tsx', '.js', '.jsx']],
  ['.jsx', ['.tsx', '.jsx']],
  ['.mjs', ['.mts', '.mjs']],
  ['.cjs', ['.cts', '.cjs']],
]);

/** Tried in order when a specifier carries no extension at all. */
const BARE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * The repo-relative paths a specifier could name, read from `fromPath`.
 *
 * Empty for a package specifier, for a path that climbs out of the repository, and for anything
 * that cannot be turned into a path. Empty means "no help available", which is the only thing a
 * caller is allowed to conclude from it - see the header on positive evidence.
 */
export function importTargets(fromPath: string, module: string): string[] {
  if (!isRelativeSpecifier(module)) return [];

  const base = posix.normalize(posix.join(posix.dirname(normalisePath(fromPath)), module));
  // `..` out of the project root. Not an error: the file is genuinely not ours to resolve.
  if (base === '.' || base === '..' || base.startsWith('../')) return [];

  const dot = base.lastIndexOf('.');
  const slash = base.lastIndexOf('/');
  const extension = dot > slash ? base.slice(dot).toLowerCase() : '';

  const targets: string[] = [];
  const rewrites = REWRITTEN_EXTENSIONS.get(extension);
  if (rewrites) {
    const stem = base.slice(0, dot);
    for (const ext of rewrites) targets.push(stem + ext);
    // `./host.d.ts` is not what anyone writes, but `./host.js` can mean a declaration file.
    targets.push(`${stem}.d.ts`);
  } else if (extension) {
    // An extension we do not rewrite - `.ts` written directly, or `.json`. Taken as written.
    targets.push(base);
  } else {
    for (const ext of BARE_EXTENSIONS) targets.push(base + ext);
    for (const ext of BARE_EXTENSIONS) targets.push(`${base}/index${ext}`);
  }
  return targets;
}

/**
 * The one candidate path this import names, or `undefined` if the import does not settle it.
 *
 * `undefined` covers every uncertain case alike - a package specifier, a target outside the
 * index, several candidates in files the specifier could all name - because the caller's next
 * move is the same in all of them: fall back to whatever it would have done without imports.
 */
export function importedTarget(
  fromPath: string,
  module: string,
  candidatePaths: readonly string[],
): string | undefined {
  const targets = importTargets(fromPath, module);
  if (targets.length === 0) return undefined;

  const wanted = new Set(candidatePaths.map(normalisePath));
  // In specifier-preference order, so `./host.js` meaning `host.ts` beats a stray `host.js`.
  for (const target of targets) {
    if (wanted.has(target)) return target;
  }
  return undefined;
}
