import { spawn } from 'node:child_process';
import { childEnv } from './redact.js';
import { killTree } from '../tools/shellRunner.js';

/**
 * Hooks (plan 0006 G3): user scripts that run at fixed points, in Claude Code's own format so an
 * existing hook script works unchanged -
 *
 *   "hooks": {
 *     "PreToolUse": [{ "matcher": "Bash|Edit", "hooks": [{ "type": "command", "command": "...", "timeout": 60 }] }]
 *   }
 *
 * Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, PreCompact, Notification.
 * The script gets one JSON object on stdin (`hook_event_name`, `session_id`, `cwd`, and per event
 * `tool_name` / `tool_input` / `tool_response` / `prompt` / `message` / `trigger` /
 * `stop_hook_active`) and answers the same two ways Claude Code reads:
 *
 * - exit code: 0 is fine; 2 blocks (stderr is the reason - the tool does not run, the prompt is not
 *   sent, the stop is refused); anything else is a non-blocking error shown to the user;
 * - JSON on stdout: `continue: false` (+ `stopReason`), `decision: "block"` (+ `reason`),
 *   `systemMessage`, and `hookSpecificOutput` with `permissionDecision` (allow / deny / ask) +
 *   `permissionDecisionReason` for PreToolUse, or `additionalContext` for UserPromptSubmit,
 *   SessionStart and PostToolUse.
 *
 * Matchers are regular expressions over the tool name, and accept Claude's names for o4c's tools
 * (Bash = run_shell, Edit = edit_file, Write = write_file, Read = read_file, Grep = grep_files,
 * Glob = glob_files), so `"matcher": "Bash"` means what it says. For the same reason a tool input
 * with a `path` is also given a `file_path`. `updatedInput` is not supported: o4c never runs a
 * different call than the one the model made and the user approved.
 */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'PreCompact', 'Notification'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  command: string;
  timeoutMs: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;

const CLAUDE_NAMES: Record<string, string> = {
  run_shell: 'Bash',
  edit_file: 'Edit',
  write_file: 'Write',
  read_file: 'Read',
  grep_files: 'Grep',
  glob_files: 'Glob',
};

export function parseHooks(value: unknown): { hooks: HookConfig; problems: string[] } {
  const hooks: HookConfig = {};
  const problems: string[] = [];
  if (value === undefined) return { hooks, problems };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { hooks, problems: ['"hooks" must be an object of event -> list of { matcher, hooks }.'] };
  for (const [event, groups] of Object.entries(value as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push(`Unknown hook event "${event}" - one of ${HOOK_EVENTS.join(', ')}.`);
      continue;
    }
    if (!Array.isArray(groups)) {
      problems.push(`hooks.${event} must be a list.`);
      continue;
    }
    const out: HookGroup[] = [];
    groups.forEach((g, i) => {
      const group = g as { matcher?: unknown; hooks?: unknown };
      const commands = Array.isArray(group?.hooks) ? group.hooks : [];
      const parsed: HookCommand[] = [];
      for (const h of commands as { type?: unknown; command?: unknown; timeout?: unknown }[]) {
        if (h?.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) {
          problems.push(`hooks.${event}[${i}]: each hook needs "type": "command" and a "command".`);
          continue;
        }
        parsed.push({ command: h.command, timeoutMs: (typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : 60) * 1000 });
      }
      if (typeof group?.matcher === 'string' && group.matcher) {
        try {
          new RegExp(group.matcher);
        } catch {
          problems.push(`hooks.${event}[${i}]: matcher "${group.matcher}" is not a valid regular expression.`);
          return;
        }
      }
      if (parsed.length) out.push({ ...(typeof group?.matcher === 'string' && group.matcher ? { matcher: group.matcher } : {}), hooks: parsed });
    });
    if (out.length) hooks[event as HookEvent] = out;
  }
  return { hooks, problems };
}

/** Does this group apply to `toolName`? No matcher (or `*`) matches everything. */
export function matches(group: HookGroup, toolName?: string): boolean {
  if (!group.matcher || group.matcher === '*' || toolName === undefined) return true;
  const re = new RegExp(`^(?:${group.matcher})$`);
  return re.test(toolName) || (CLAUDE_NAMES[toolName] !== undefined && re.test(CLAUDE_NAMES[toolName]!));
}

export interface HookOutcome {
  /** Exit 2, `decision: "block"`, or `continue: false` - with why. */
  block?: string;
  /** PreToolUse only. */
  permission?: 'allow' | 'deny' | 'ask';
  permissionReason?: string;
  additionalContext: string[];
  /** For the user: systemMessage, and stderr from non-blocking failures. */
  messages: string[];
}

export interface RunHookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type HookRunner = (command: string, stdin: string, timeoutMs: number, cwd: string) => Promise<RunHookResult>;

export const runHookCommand: HookRunner = (command, stdin, timeoutMs, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env: childEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });

/** Claude-compatible input: o4c's own fields, plus `file_path` where the tool takes a `path`. */
export function hookToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input.path === 'string' && input.file_path === undefined ? { ...input, file_path: input.path } : input;
}

/** Runs every hook of `event` that matches, in order, and folds their answers into one outcome. */
export async function runHooks(
  config: HookConfig,
  event: HookEvent,
  payload: Record<string, unknown>,
  opts: { toolName?: string; cwd?: string; sessionId?: string; runner?: HookRunner } = {},
): Promise<HookOutcome> {
  const outcome: HookOutcome = { additionalContext: [], messages: [] };
  const groups = (config[event] ?? []).filter((g) => matches(g, opts.toolName));
  const cwd = opts.cwd ?? process.cwd();
  const input = JSON.stringify({ hook_event_name: event, session_id: opts.sessionId ?? '', cwd, ...payload });
  for (const group of groups) {
    for (const hook of group.hooks) {
      const r = await (opts.runner ?? runHookCommand)(hook.command, input, hook.timeoutMs, cwd);
      const label = `${event} hook "${hook.command.length > 60 ? `${hook.command.slice(0, 57)}...` : hook.command}"`;
      if (r.timedOut) {
        outcome.messages.push(`${label} timed out after ${hook.timeoutMs / 1000} s and was stopped.`);
        continue;
      }
      if (r.code === 2) {
        outcome.block ??= r.stderr.trim() || `${label} blocked this.`;
        continue;
      }
      if (r.code !== 0) {
        outcome.messages.push(`${label} failed (exit ${r.code ?? 'none'}): ${r.stderr.trim().slice(0, 500)}`);
        continue;
      }
      let json: Record<string, unknown> | undefined;
      try {
        const text = r.stdout.trim();
        json = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      } catch {
        json = undefined;
      }
      if (!json) {
        // Plain stdout: context for the events that take it, otherwise just shown.
        const text = r.stdout.trim();
        if (text && (event === 'UserPromptSubmit' || event === 'SessionStart')) outcome.additionalContext.push(text);
        continue;
      }
      if (typeof json.systemMessage === 'string') outcome.messages.push(json.systemMessage);
      if (json.continue === false) outcome.block ??= typeof json.stopReason === 'string' ? json.stopReason : `${label} stopped this.`;
      if (json.decision === 'block') outcome.block ??= typeof json.reason === 'string' ? json.reason : `${label} blocked this.`;
      const specific = json.hookSpecificOutput as Record<string, unknown> | undefined;
      if (specific) {
        const pd = specific.permissionDecision;
        if (event === 'PreToolUse' && (pd === 'allow' || pd === 'deny' || pd === 'ask')) {
          // The strictest answer wins across hooks: deny > ask > allow.
          const rank = { allow: 0, ask: 1, deny: 2 } as const;
          if (!outcome.permission || rank[pd] > rank[outcome.permission]) {
            outcome.permission = pd;
            outcome.permissionReason = typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : undefined;
          }
        }
        if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) outcome.additionalContext.push(specific.additionalContext.trim());
      }
    }
  }
  return outcome;
}

/** `/hooks`: what is configured, event by event. */
export function describeHooks(config: HookConfig, problems: readonly string[]): string[] {
  const lines: string[] = ['Hooks (config "hooks", Claude Code format):'];
  let any = false;
  for (const event of HOOK_EVENTS) {
    for (const g of config[event] ?? []) {
      any = true;
      for (const h of g.hooks) lines.push(`  ${event.padEnd(17)} ${(g.matcher ?? '*').padEnd(14)} ${h.command}  (timeout ${h.timeoutMs / 1000} s)`);
    }
  }
  if (!any) lines.push('  none configured.');
  if (problems.length) lines.push('', 'Problems (those entries are ignored):', ...problems.map((p) => `  ${p}`));
  return lines;
}

let current: { config: HookConfig; problems: string[] } = { config: {}, problems: [] };

/** Set once at startup from the resolved config. */
export function setHooks(next: { hooks: HookConfig; problems: string[] }): void {
  current = { config: next.hooks, problems: next.problems };
}

export function hooksConfig(): HookConfig {
  return current.config;
}

export function hookProblems(): string[] {
  return current.problems;
}

export function hasHooks(event: HookEvent): boolean {
  return (current.config[event]?.length ?? 0) > 0;
}

/** PostToolUse as a core component: the tool runs, then the hooks see its result; a block or added
 * context is appended to what the model gets back. */
export function postToolHooksComponent(opts: { sessionId?: string; cwd?: string; onMessage?: (text: string) => void } = {}): {
  name: string;
  aroundTool(call: { tool: { name: string }; input: Record<string, unknown> }, next: () => Promise<string>): Promise<string>;
} {
  return {
    name: 'hooks',
    async aroundTool(call, next) {
      const out = await next();
      if (!hasHooks('PostToolUse')) return out;
      const h = await runHooks(hooksConfig(), 'PostToolUse', { tool_name: call.tool.name, tool_input: hookToolInput(call.input), tool_response: out }, { toolName: call.tool.name, sessionId: opts.sessionId, cwd: opts.cwd });
      for (const m of h.messages) opts.onMessage?.(m);
      const extra = [...(h.block ? [`[PostToolUse hook] ${h.block}`] : []), ...h.additionalContext.map((c) => `[PostToolUse hook] ${c}`)];
      return extra.length ? `${out}\n\n${extra.join('\n')}` : out;
    },
  };
}
/**
 * PreToolUse, as a permission answer: `undefined` when no hook has a say; `'allow'` skips the
 * approval dialog (Claude Code semantics), `'ask'` forces it, a deny carries the hook's reason.
 */
export async function preToolHookVerdict(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
  onMessage: (text: string) => void = (t) => console.error(t),
): Promise<'allow' | 'ask' | { verdict: 'deny'; reason: string } | undefined> {
  if (!hasHooks('PreToolUse')) return undefined;
  const h = await runHooks(hooksConfig(), 'PreToolUse', { tool_name: toolName, tool_input: hookToolInput(input) }, { toolName, cwd });
  for (const m of h.messages) onMessage(m);
  if (h.block) return { verdict: 'deny', reason: `a PreToolUse hook blocked it: ${h.block}` };
  if (h.permission === 'deny') return { verdict: 'deny', reason: `a PreToolUse hook denied it${h.permissionReason ? `: ${h.permissionReason}` : ''}` };
  return h.permission;
}
