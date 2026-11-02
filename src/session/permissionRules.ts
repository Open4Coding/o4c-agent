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

// ------------------------------------------------------------------ rules (plan 0006 C3)

export type RuleScope = 'global' | 'local' | 'personal' | 'built-in' | 'protectedPaths';

/**
 * Read-only shell commands allowed without asking - only when the user turns it on
 * (`/set-autoallowreadonly on`, config `autoAllowReadOnly`); off by default (C3).
 */
export const READ_ONLY_SHELL: readonly string[] = [
  'git status*', 'git diff*', 'git log*', 'git show*', 'git branch', 'git branch --list*',
  'ls', 'ls *', 'dir', 'dir *', 'pwd', 'cd', 'echo *', 'cat *', 'type *', 'head *', 'tail *',
  'wc *', 'which *', 'where *', 'node --version', 'npm --version', 'python --version',
].map((p) => `run_shell(${p})`);
export interface Rule {
  pattern: string;
  scope: RuleScope;
}
export interface PermissionRules {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
  /** Config `confirmDestructive` (C5): destructive shell commands always ask. */
  confirmDestructive?: boolean;
}
export interface RuleDecision {
  decision: 'allow' | 'ask' | 'deny';
  rule: Rule;
}

export const EMPTY_RULES: PermissionRules = { allow: [], ask: [], deny: [] };

/**
 * The rules from each scope's own config file, kept apart so `/view-permissions` can say where each
 * came from. Lists add up across scopes - a project rule does not hide a global one.
 */
export async function loadRules(readScope: (scope: RuleScope) => Promise<Record<string, unknown>>): Promise<PermissionRules> {
  const out: PermissionRules = { allow: [], ask: [], deny: [] };
  for (const scope of ['global', 'local', 'personal'] as const) {
    const p = (await readScope(scope)).permissions as Partial<Record<keyof PermissionRules, unknown>> | undefined;
    for (const kind of ['allow', 'ask', 'deny'] as const) {
      const list = p?.[kind];
      if (Array.isArray(list)) for (const pattern of list) if (typeof pattern === 'string' && pattern.trim()) out[kind].push({ pattern: pattern.trim(), scope });
    }
  }
  const merged = { ...(await readScope('global')), ...(await readScope('local')), ...(await readScope('personal')) };
  if (merged.autoAllowReadOnly === true) for (const pattern of READ_ONLY_SHELL) out.allow.push({ pattern, scope: 'built-in' });
  // C5: protected paths are deny rules for the tools that change files.
  if (Array.isArray(merged.protectedPaths)) {
    for (const glob of merged.protectedPaths) {
      if (typeof glob !== 'string' || !glob.trim()) continue;
      for (const t of ['write_file', 'edit_file']) out.deny.push({ pattern: `${t}(${glob.trim()})`, scope: 'protectedPaths' });
    }
  }
  if (merged.confirmDestructive === true) out.confirmDestructive = true;
  return out;
}

/**
 * What the rules say about a call, or undefined when none applies. Deny beats ask beats allow. A
 * shell command is judged per segment (split on && || ; | &): any denied or asked segment decides
 * for the whole command, and allow needs every segment allowed - so `npm test && rm -rf ~` is not
 * let through by `run_shell(npm test*)`.
 */
export function evaluateRules(rules: PermissionRules, tool: Tool, input: Record<string, unknown>, split: (command: string) => string[], cwd = process.cwd()): RuleDecision | undefined {
  const calls =
    tool.name === 'run_shell' && typeof input.command === 'string'
      ? split(input.command).map((command) => ({ ...input, command }))
      : [input];
  const first = (list: Rule[], each: Record<string, unknown>) => list.find((r) => matchesPattern(r.pattern, tool, each, cwd));
  for (const each of calls) {
    const rule = first(rules.deny, each);
    if (rule) return { decision: 'deny', rule };
  }
  for (const each of calls) {
    const rule = first(rules.ask, each);
    if (rule) return { decision: 'ask', rule };
  }
  const allowed = calls.map((each) => first(rules.allow, each));
  if (calls.length > 0 && allowed.every(Boolean)) return { decision: 'allow', rule: allowed[0]! };
  return undefined;
}

/** For /view-permissions. */
export function describeRules(rules: PermissionRules): string[] {
  const lines: string[] = [];
  for (const kind of ['deny', 'ask', 'allow'] as const) {
    lines.push(`${kind}:${rules[kind].length ? '' : ' (none)'}`);
    for (const r of rules[kind]) lines.push(`  ${r.pattern.padEnd(40)} (${r.scope})`);
  }
  return lines;
}
