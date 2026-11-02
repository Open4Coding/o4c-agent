import { dirname, isAbsolute, relative } from 'node:path';
import type { Tool } from '../tools/types.js';
import { globToRegExp } from '../tools/searchUtils.js';

/**
 * Permission patterns (plan 0006 C2/C3): `tool`, or `tool(argument glob)` -
 * `run_shell(npm test*)` matches a command, `edit_file(src/**)` a project-relative path.
 * `*` in a command pattern matches anything; a path pattern uses the same glob rules as glob_files.
 */

const PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'glob_files', 'grep_files']);

function projectPath(path: string, cwd: string): string {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The pattern "always allow" saves for this call: specific enough to be safe, general enough to help. */
export function patternFor(tool: Tool, input: Record<string, unknown>, cwd = process.cwd()): string {
  if (tool.name === 'run_shell' && typeof input.command === 'string') {
    const words = input.command.trim().split(/\s+/);
    // "npm test -- --watch" -> "npm test*"; a one-word command -> "make*".
    return `run_shell(${words.slice(0, Math.min(2, words.length)).join(' ')}*)`;
  }
  if (PATH_TOOLS.has(tool.name) && typeof input.path === 'string') {
    const dir = dirname(projectPath(input.path, cwd));
    return `${tool.name}(${dir === '.' || dir === '' ? '**' : `${dir}/**`})`;
  }
  return tool.name;
}

/** Whether a pattern covers this call. */
export function matchesPattern(pattern: string, tool: Tool, input: Record<string, unknown>, cwd = process.cwd()): boolean {
  const m = /^([\w.-]+)(?:\((.*)\))?$/.exec(pattern.trim());
  if (!m || m[1] !== tool.name) return false;
  const arg = m[2];
  if (arg === undefined) return true;
  if (tool.name === 'run_shell') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const re = new RegExp(`^${arg.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
    return re.test(command);
  }
  if (typeof input.path !== 'string') return false;
  return globToRegExp(arg).test(projectPath(input.path, cwd));
}
