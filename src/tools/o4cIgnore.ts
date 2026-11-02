import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { IgnoreRules } from './gitignore.js';
import type { CoreComponent } from '../agent/coreSeam.js';

/**
 * `.o4cignore` (plan 0006 C5, off unless the file exists): files o4c should not see or touch -
 * credentials, private notes, a vendored tree that is not the model's business. Same syntax as
 * `.gitignore`, one file at the project root. Matching files are left out of glob_files and
 * grep_files, and read_file / write_file / edit_file on them are refused.
 *
 * Not a sandbox: run_shell can still reach them, which the refusal message does not pretend
 * otherwise. Combine with permission rules (deny run_shell patterns) where that matters.
 */
export const O4CIGNORE_FILENAME = '.o4cignore';

let active: { root: string; rules: IgnoreRules } | undefined;

/** Loads the project's `.o4cignore`, or clears it when there is none. */
export function loadO4cIgnore(projectRoot: string | undefined): boolean {
  active = undefined;
  if (!projectRoot) return false;
  try {
    const text = readFileSync(join(projectRoot, O4CIGNORE_FILENAME), 'utf-8');
    const rules = IgnoreRules.empty().with('', text);
    if (!rules.isEmpty) active = { root: resolve(projectRoot), rules };
  } catch {
    // no file: nothing ignored
  }
  return active !== undefined;
}

/** For tests. */
export function setO4cIgnore(root: string, text: string): void {
  active = { root: resolve(root), rules: IgnoreRules.empty().with('', text) };
}

export function clearO4cIgnore(): void {
  active = undefined;
}

/** Whether `.o4cignore` excludes this path (absolute, or relative to the current directory). */
export function isO4cIgnored(path: string, isDirectory = false): boolean {
  if (!active) return false;
  const abs = isAbsolute(path) ? path : resolve(path);
  const rel = relative(active.root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false;
  return active.rules.ignores(rel, isDirectory);
}

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/** Refuses the file tools on ignored paths, before the tool runs - so headless runs are covered too. */
export function o4cIgnoreComponent(): CoreComponent {
  return {
    name: 'o4cignore',
    async aroundTool({ tool, input }, next) {
      if (FILE_TOOLS.has(tool.name) && typeof input.path === 'string' && isO4cIgnored(input.path)) {
        return `Error: ${input.path} is excluded by the project's .o4cignore, so o4c does not ${tool.name === 'read_file' ? 'read' : 'change'} it. Leave it alone, or ask the user.`;
      }
      return next();
    },
  };
}
