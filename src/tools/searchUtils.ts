import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { GITIGNORE_FILENAME, IgnoreRules, loadRulesDownTo } from './gitignore.js';

/**
 * Directories never walked, whatever `.gitignore` says.
 *
 * `.git` because git itself never tracks it. `node_modules` because searching it is never what
 * was meant and it is routinely tens of thousands of files, so the cost of being wrong once is
 * lower than the cost of walking it on every search. `dist` is **not** in this list any more: it
 * is in `SKIP_WITHOUT_GIT` instead, because inside a repository the right answer is whatever that
 * repository's own `.gitignore` says - a project that tracks its `dist/` should be able to search
 * it.
 */
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git']);

/** Added to the skip list only when there are no ignore rules to consult - see above. */
const SKIP_WITHOUT_GIT = new Set(['dist']);

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // skip large/binary-likely files (model weights, etc.)

export interface WalkEntry {
  /** Path relative to baseDir, forward slashes regardless of platform, never a trailing slash. */
  path: string;
  isDirectory: boolean;
}

export interface WalkResult {
  readonly entries: WalkEntry[];
  /**
   * How many paths the ignore rules removed.
   *
   * A skipped directory counts once, not once per file inside it, because the walk never looks
   * inside - so this is a floor rather than a total. It is reported at all so a caller can tell
   * "nothing matched" from "nothing matched in what I was allowed to look at", which is the
   * distinction an empty `grep` result otherwise destroys.
   */
  readonly ignored: number;
}

export interface WalkOptions {
  /**
   * Honour `.gitignore`, `.git/info/exclude` and nested ignore files. On by default.
   *
   * Off is for a caller that genuinely wants everything, and for the script that checks this
   * walker against `git check-ignore`.
   */
  readonly respectGitignore?: boolean;
}

/** Where a walk sits inside a git repository, when it sits inside one at all. */
interface GitContext {
  readonly repoRoot: string;
  /** The walk's base directory, relative to `repoRoot`. `''` when they are the same. */
  readonly baseFromRoot: string;
}

/**
 * Recursively lists files and directories under `baseDir`. Paths are relative to it,
 * with forward slashes regardless of platform (so glob patterns match consistently) and
 * never a trailing slash, even for directories - callers append one for display if wanted,
 * keeping the path usable as-is for glob matching (a trailing `/` would break patterns
 * like `*` from matching a directory name, since `*` excludes `/`).
 *
 * Skips `node_modules`, `.git`, files above MAX_FILE_SIZE_BYTES, and - unless asked not to -
 * everything the repository's ignore files exclude. See `gitignore.ts` for what that covers, what
 * it deliberately does not, and how it is checked against git itself.
 */
export async function walkFiles(baseDir: string, options: WalkOptions = {}): Promise<WalkResult> {
  const entries: WalkEntry[] = [];
  let ignored = 0;

  const context = options.respectGitignore === false ? undefined : await gitContext(baseDir);
  const rootRules = context
    ? await loadRulesDownTo(context.repoRoot, context.baseFromRoot)
    : IgnoreRules.empty();

  const fromRoot = (relPath: string): string =>
    context?.baseFromRoot ? `${context.baseFromRoot}/${relPath}` : relPath;

  async function walk(dir: string, relPrefix: string, inherited: IgnoreRules): Promise<void> {
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // A directory's own `.gitignore` applies to everything in it, so it has to be read before any
    // of its entries are judged. Spotted in the listing rather than probed for, which costs
    // nothing; the base directory's own file was already loaded by `loadRulesDownTo`.
    let rules = inherited;
    if (context && relPrefix) {
      const own = dirEntries.find((e) => e.isFile() && e.name === GITIGNORE_FILENAME);
      if (own) {
        try {
          rules = rules.with(fromRoot(relPrefix), await readFile(join(dir, own.name), 'utf-8'));
        } catch {
          // Unreadable: the subtree keeps the rules it inherited, which is the safe direction -
          // a file stays visible rather than being hidden by a rule nobody could read.
        }
      }
    }

    for (const entry of dirEntries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (!context && SKIP_WITHOUT_GIT.has(entry.name)) continue;
        if (rules.ignores(fromRoot(relPath), true)) {
          ignored++;
          continue;
        }
        entries.push({ path: relPath, isDirectory: true });
        await walk(join(dir, entry.name), relPath, rules);
      } else if (entry.isFile()) {
        if (rules.ignores(fromRoot(relPath), false)) {
          ignored++;
          continue;
        }
        try {
          const info = await stat(join(dir, entry.name));
          if (info.size > MAX_FILE_SIZE_BYTES) continue;
        } catch {
          continue;
        }
        entries.push({ path: relPath, isDirectory: false });
      }
    }
  }

  await walk(baseDir, '', rootRules);
  return { entries, ignored };
}

/**
 * The repository `baseDir` sits in, or `undefined` if it is not in one.
 *
 * Walks up looking for `.git`, which may be a directory or - in a worktree or a submodule - a
 * file. Either way its presence marks the root, and the root is what every unanchored pattern is
 * measured from. A `.gitignore` *above* the directory a search was pointed at still applies,
 * which is the part that is easy to get wrong when the search is given a subdirectory.
 */
async function gitContext(baseDir: string): Promise<GitContext | undefined> {
  const segments: string[] = [];
  let current = resolve(baseDir);

  for (;;) {
    try {
      await stat(join(current, '.git'));
      return { repoRoot: current, baseFromRoot: segments.reverse().join('/') };
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      segments.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * Converts a glob pattern to a RegExp. Supports `*` (any chars except `/`),
 * `**` (any chars including `/`, matching zero or more path segments when
 * followed by `/`), and `?` (a single char except `/`). Not a full glob spec
 * (no brace expansion, character classes, etc.) - deliberately scoped to the
 * common patterns a coding agent actually needs.
 *
 * Not the matcher `gitignore.ts` uses: a pattern from the model is anchored whole, where a
 * gitignore pattern is anchored by its own shape and by the file it came from.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
