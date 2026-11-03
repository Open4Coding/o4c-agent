import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The solution scope (plan 0006 E21): a group of repos that share instructions and settings. A
 * solution is the nearest folder above a project that holds a `.o4c-solution` folder; its
 * `config.json` sits between global and the project's own config (global < solution < project <
 * personal), and its `O4C.md` (or AGENTS.md / CLAUDE.md) is read after the global one and before the
 * project's. Created by hand - `mkdir ../.o4c-solution` beside the repos - and edited with
 * `/edit-config`.
 */
export const SOLUTION_DIR = '.o4c-solution';

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The `.o4c-solution` folder that applies to `projectRoot`, or undefined. The project's own folder
 * does not count - a solution is above the projects in it. */
export function findSolutionDir(projectRoot: string | undefined): string | undefined {
  if (!projectRoot) return undefined;
  let dir = dirname(projectRoot);
  for (;;) {
    const candidate = join(dir, SOLUTION_DIR);
    if (isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
