import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CoreComponent } from '../agent/coreSeam.js';

/**
 * Instruction files (plan 0006 D1). o4c's own is `O4C.md`; a project that has none but carries an
 * `AGENTS.md` (the cross-tool convention) or a `CLAUDE.md` gets that instead, so o4c follows the
 * instructions the project already wrote down. One file per directory, first found in that order.
 *
 * `@path` inside a file imports another file in its place (relative to the importing file), up to
 * IMPORT_DEPTH deep, each file once. Only a token that names an existing file counts, so an email
 * address or a decorator is left as it is.
 */
export const INSTRUCTION_NAMES: readonly string[] = ['o4c.md', 'agents.md', 'claude.md'];
const IMPORT_DEPTH = 3;
const MAX_IMPORT_CHARS = 20_000;
const MAX_SUBDIR_CHARS = 6_000;

/** The instruction file in `dir`, if any - case-insensitive, first of INSTRUCTION_NAMES found. */
export function instructionFileIn(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const wanted of INSTRUCTION_NAMES) {
    const hit = names.find((n) => n.toLowerCase() === wanted);
    if (hit) {
      const path = join(dir, hit);
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // vanished between the listing and the stat
      }
    }
  }
  return undefined;
}

/** `text` with each `@path` naming an existing file replaced by that file's contents. */
export function expandImports(text: string, baseDir: string, depth = 0, seen: Set<string> = new Set()): string {
  if (depth >= IMPORT_DEPTH) return text;
  return text.replace(/(^|\s)@([\w./\\~-]+)/gm, (whole, lead: string, ref: string) => {
    const target = isAbsolute(ref) ? ref : resolve(baseDir, ref);
    if (seen.has(target) || !existsSync(target)) return whole;
    try {
      if (!statSync(target).isFile()) return whole;
      seen.add(target);
      let body = readFileSync(target, 'utf-8');
      if (body.length > MAX_IMPORT_CHARS) body = `${body.slice(0, MAX_IMPORT_CHARS)}\n... (import cut at ${MAX_IMPORT_CHARS.toLocaleString()} characters)`;
      return `${lead}--- imported ${ref} ---\n${expandImports(body.trim(), dirname(target), depth + 1, seen)}\n--- end of ${ref} ---`;
    } catch {
      return whole;
    }
  });
}

/** One instruction file, read and with its imports expanded. */
export function loadInstructionFile(path: string): string {
  try {
    return expandImports(readFileSync(path, 'utf-8'), dirname(path), 0, new Set([resolve(path)]));
  } catch {
    return '';
  }
}

const TOUCH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'glob_files', 'grep_files']);

/**
 * Instruction files in subdirectories (D1): the startup prompt carries those from the project root
 * down to the working directory; one deeper down is given to the model the first time it touches a
 * file there - appended to that tool result, once per session (persisted, since o4c reloads after
 * most turns).
 */
export function subdirInstructionsComponent(options: { projectRoot: string; cwd?: string; seenFile?: string }): CoreComponent {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = resolve(options.projectRoot);
  let seen = new Set<string>();
  if (options.seenFile) {
    try {
      seen = new Set(JSON.parse(readFileSync(options.seenFile, 'utf-8')) as string[]);
    } catch {
      // first time
    }
  }
  const save = () => {
    if (!options.seenFile) return;
    try {
      mkdirSync(dirname(options.seenFile), { recursive: true });
      writeFileSync(options.seenFile, JSON.stringify([...seen]));
    } catch {
      // costs a repeat at worst
    }
  };
  return {
    name: 'subdir-instructions',
    async aroundTool({ tool, input }, next) {
      const result = await next();
      if (!TOUCH_TOOLS.has(tool.name) || typeof input.path !== 'string' || result.startsWith('Error')) return result;
      const target = resolve(cwd, input.path);
      let dir = target;
      try {
        if (!statSync(target).isDirectory()) dir = dirname(target);
      } catch {
        dir = dirname(target);
      }
      // Directories strictly below the working directory, down to the touched one, within the project.
      const relFromCwd = relative(cwd, dir);
      if (!relFromCwd || relFromCwd.startsWith('..') || isAbsolute(relFromCwd) || relative(root, dir).startsWith('..')) return result;
      const parts = relFromCwd.split(/[\\/]/);
      const notes: string[] = [];
      for (let i = 1; i <= parts.length; i++) {
        const d = join(cwd, ...parts.slice(0, i));
        if (seen.has(d)) continue;
        seen.add(d);
        const file = instructionFileIn(d);
        if (!file) continue;
        let body = loadInstructionFile(file).trim();
        if (body.length > MAX_SUBDIR_CHARS) body = `${body.slice(0, MAX_SUBDIR_CHARS)}\n... (cut; read ${relative(cwd, file)} for the rest)`;
        if (body) notes.push(`[o4c] Instructions for ${relative(cwd, d).replace(/\\/g, '/')}/ (${relative(cwd, file).replace(/\\/g, '/')}), shown the first time you work there - follow them for files in that directory:\n${body}`);
      }
      if (seen.size) save();
      return notes.length ? `${result}\n\n${notes.join('\n\n')}` : result;
    },
  };
}
