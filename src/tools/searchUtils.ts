import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // skip large/binary-likely files (model weights, etc.)

export interface WalkEntry {
  /** Path relative to baseDir, forward slashes regardless of platform, never a trailing slash. */
  path: string;
  isDirectory: boolean;
}

/**
 * Recursively lists files and directories under `baseDir`. Paths are relative to it,
 * with forward slashes regardless of platform (so glob patterns match consistently) and
 * never a trailing slash, even for directories - callers append one for display if wanted,
 * keeping the path usable as-is for glob matching (a trailing `/` would break patterns
 * like `*` from matching a directory name, since `*` excludes `/`).
 * Skips node_modules/.git/dist and files above MAX_FILE_SIZE_BYTES.
 */
export async function walkFiles(baseDir: string): Promise<WalkEntry[]> {
  const results: WalkEntry[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        results.push({ path: relPath, isDirectory: true });
        await walk(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        try {
          const info = await stat(join(dir, entry.name));
          if (info.size > MAX_FILE_SIZE_BYTES) continue;
        } catch {
          continue;
        }
        results.push({ path: relPath, isDirectory: false });
      }
    }
  }

  await walk(baseDir, '');
  return results;
}

/**
 * Converts a glob pattern to a RegExp. Supports `*` (any chars except `/`),
 * `**` (any chars including `/`, matching zero or more path segments when
 * followed by `/`), and `?` (a single char except `/`). Not a full glob spec
 * (no brace expansion, character classes, etc.) - deliberately scoped to the
 * common patterns a coding agent actually needs.
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
