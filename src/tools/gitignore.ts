/**
 * `.gitignore`, applied to the file walk that `grep_files`, `glob_files` and the Code Graph share.
 *
 * ## Why this exists
 *
 * It was found by measurement rather than by taste. o4c's own working tree carries 32 untracked
 * scratch files under `.tmp-repro/`, left over from a terminal-debugging session, and because the
 * walker skipped only `node_modules`, `.git` and `dist`, the Code Graph indexed them like source:
 * they contributed 27 definitions of `write` on their own, which made a genuinely ambiguous name
 * far worse and cost real recall in the graded acceptance cells
 * (`.docs/code-graph-acceptance.md`). The same files are in every `grep_files` result that
 * touches the terminal code.
 *
 * ## Written here rather than taken from npm
 *
 * `ignore` would have done it, but the install is eight runtime dependencies and the design
 * criteria put install size and zero native modules first. The semantics are a published spec
 * (`gitignore(5)`) and they fit in a page, so the trade is a page of code against a ninth
 * dependency.
 *
 * The risk of writing it is that a matcher bug **silently hides files from search**, which is the
 * failure this whole area is careful about - an empty `grep` result the model reads as "not
 * there". So it is checked against git itself: `scripts/gitignore-check.mjs` asks
 * `git check-ignore` about every path in a repository and compares, which is the same move as
 * grading the Code Graph against `tsc` rather than against a second guess.
 *
 * ## What is deliberately not supported
 *
 * - **`core.excludesFile`** (the user's global ignore list). Reading it means parsing git config
 *   and resolving `~`, and a pattern there would make o4c's view of a repository depend on the
 *   machine. `.git/info/exclude` *is* read, because it is per-repository and sits in a fixed
 *   place.
 * - **Re-including a path inside an excluded directory.** Not a gap: git cannot do it either, and
 *   for the same reason - the walk never descends into an excluded directory, so nothing inside
 *   is ever offered to a negated pattern.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One compiled `.gitignore` line. */
interface Pattern {
  readonly regex: RegExp;
  /** `!pattern` - re-includes, and the last matching pattern in a file wins. */
  readonly negated: boolean;
  /** `pattern/` - matches a directory and never a file. */
  readonly dirOnly: boolean;
}

/** The patterns from one `.gitignore`, and the directory they are relative to. */
interface PatternGroup {
  /** Path of the directory holding this file, relative to the repository root. `''` at the root. */
  readonly base: string;
  readonly patterns: readonly Pattern[];
}

/**
 * The ignore rules in force at one point in a walk.
 *
 * Immutable, and `enter` returns a new instance rather than mutating, because a `.gitignore` in
 * one directory must not leak into its siblings. The groups themselves are shared by reference,
 * so descending costs an array spread of a handful of elements rather than a copy of the rules.
 */
export class IgnoreRules {
  private constructor(private readonly groups: readonly PatternGroup[]) {}

  static empty(): IgnoreRules {
    return new IgnoreRules([]);
  }

  get isEmpty(): boolean {
    return this.groups.length === 0;
  }

  /** The rules with one more `.gitignore` added, anchored at `base`. */
  with(base: string, text: string): IgnoreRules {
    const patterns = compilePatterns(text);
    return patterns.length === 0 ? this : new IgnoreRules([...this.groups, { base, patterns }]);
  }

  /**
   * Whether git would ignore this path.
   *
   * `path` is relative to the **repository root**, with forward slashes. Deeper `.gitignore`
   * files win over shallower ones, and within one file the last matching line wins - which is
   * what makes `!` work.
   */
  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const group of this.groups) {
      if (group.base && !path.startsWith(`${group.base}/`)) continue;
      const relative = group.base ? path.slice(group.base.length + 1) : path;
      for (const pattern of group.patterns) {
        if (pattern.dirOnly && !isDirectory) continue;
        if (pattern.regex.test(relative)) ignored = !pattern.negated;
      }
    }
    return ignored;
  }
}

/**
 * Compiles the lines of one `.gitignore`.
 *
 * Order is preserved, because "the last matching pattern decides" is the rule that makes negation
 * mean anything.
 */
function compilePatterns(text: string): Pattern[] {
  const patterns: Pattern[] = [];
  for (const raw of text.split('\n')) {
    const pattern = compilePattern(raw);
    if (pattern) patterns.push(pattern);
  }
  return patterns;
}

function compilePattern(raw: string): Pattern | undefined {
  // Trailing whitespace is not part of a pattern unless escaped; leading whitespace is.
  let line = raw.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '');
  if (!line || line.startsWith('#')) return undefined;

  const negated = line.startsWith('!');
  if (negated) line = line.slice(1);
  // `\#foo` and `\!foo` mean a literal `#` or `!` in the first column.
  if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);

  const dirOnly = line.endsWith('/') && !line.endsWith('\\/');
  if (dirOnly) line = line.slice(0, -1);
  if (!line) return undefined;

  // A separator anywhere but the end anchors the pattern to the .gitignore's own directory.
  // Without one, it may match at any depth below - which is why `build` ignores `src/build` and
  // `/build` does not.
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  const body = globBody(line);
  const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  try {
    return { regex: new RegExp(source), negated, dirOnly };
  } catch {
    // A pattern that will not compile - an unbalanced `[`, say. Dropping it is the safe failure:
    // a file stays visible, which is recoverable, where hiding one silently is not.
    return undefined;
  }
}

/**
 * The regex body for a gitignore glob.
 *
 * Differs from `globToRegExp` in `searchUtils.ts`, which is for the model-facing `glob_files`
 * patterns: this one has to handle `**` in three positions, character classes, and backslash
 * escapes, and it is anchored by its caller rather than by itself.
 */
function globBody(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeLiteral(pattern[i + 1]);
      i += 2;
      continue;
    }

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` at the start or in the middle spans any number of directories, including none;
        // a trailing `/**` takes everything underneath.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (c === '[') {
      const close = findClassEnd(pattern, i);
      if (close > 0) {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
      // An unclosed `[` is a literal `[` to git.
      out += '\\[';
      i += 1;
      continue;
    }

    out += escapeLiteral(c);
    i += 1;
  }

  return out;
}

/** The index of the `]` closing a character class opened at `start`, or -1. */
function findClassEnd(pattern: string, start: number): number {
  // A `]` immediately after `[` or `[!` is a literal member, per POSIX.
  let i = start + 1;
  if (pattern[i] === '!') i += 1;
  if (pattern[i] === ']') i += 1;
  for (; i < pattern.length; i++) {
    if (pattern[i] === '\\') i += 1;
    else if (pattern[i] === ']') return i;
  }
  return -1;
}

function escapeLiteral(c: string): string {
  return /[.+^${}()|[\]\\*?]/.test(c) ? `\\${c}` : c;
}

/** `.git/info/exclude`, read as if it were a root-level `.gitignore`. */
const REPO_EXCLUDE = join('.git', 'info', 'exclude');

/** The name a directory's own ignore file has, exported so the walker can spot it in a readdir. */
export const GITIGNORE_FILENAME = '.gitignore';

/**
 * The rules that apply to `baseDirFromRoot` within a repository rooted at `repoRoot`.
 *
 * Loads `.git/info/exclude` and then every `.gitignore` from the repository root down to the
 * directory the walk starts in - because a `.gitignore` above the starting point still applies,
 * which is easy to forget when the walk is given a subdirectory.
 */
export async function loadRulesDownTo(
  repoRoot: string,
  baseDirFromRoot: string,
): Promise<IgnoreRules> {
  let rules = IgnoreRules.empty();

  const exclude = await readIfPresent(join(repoRoot, REPO_EXCLUDE));
  if (exclude !== undefined) rules = rules.with('', exclude);

  const segments = baseDirFromRoot ? baseDirFromRoot.split('/') : [];
  for (let depth = 0; depth <= segments.length; depth++) {
    const base = segments.slice(0, depth).join('/');
    const text = await readIfPresent(join(repoRoot, base, GITIGNORE_FILENAME));
    if (text !== undefined) rules = rules.with(base, text);
  }
  return rules;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}
