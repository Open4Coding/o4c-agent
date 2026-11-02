import { spawnSync } from 'node:child_process';

/**
 * Files that change together (plan 0006 D10), mined from the project's own git history - read
 * only, the user's repository is never written. A pair counts once per commit that touched both;
 * commits touching more than MAX_FILES_PER_COMMIT files (mass renames, formatting sweeps) say
 * nothing about relatedness and are skipped.
 */
const MAX_COMMITS = 500;
const MAX_FILES_PER_COMMIT = 30;

export interface CochangeData {
  head: string;
  /** Commits that touched each file. */
  files: Map<string, number>;
  /** Commits that touched both, keyed `a\0b` with a < b. */
  pairs: Map<string, number>;
}

function git(root: string, args: string[]): string | undefined {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

export function currentHead(root: string): string | undefined {
  return git(root, ['rev-parse', 'HEAD'])?.trim() || undefined;
}

export function mineCochange(root: string): CochangeData | undefined {
  const head = currentHead(root);
  if (!head) return undefined;
  const log = git(root, ['log', `-n${MAX_COMMITS}`, '--no-merges', '--name-only', '--pretty=format:%x00']);
  if (log === undefined) return undefined;
  const files = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const commit of log.split('\0')) {
    const changed = [...new Set(commit.split('\n').map((l) => l.trim()).filter(Boolean))].sort();
    if (changed.length === 0 || changed.length > MAX_FILES_PER_COMMIT) continue;
    for (const f of changed) files.set(f, (files.get(f) ?? 0) + 1);
    for (let i = 0; i < changed.length; i++) {
      for (let j = i + 1; j < changed.length; j++) {
        const key = `${changed[i]}\0${changed[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return { head, files, pairs };
}
