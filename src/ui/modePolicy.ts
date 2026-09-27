import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Tool } from '../tools/types.js';

export type Mode = 'manual' | 'auto' | 'acceptEdits' | 'plan' | 'planWrite';

export interface ModeInfo {
  mode: Mode;
  label: string;
  /** Shown next to the label in /mode's picker - what this mode actually does to write_file and
   * run_shell, kept in sync with classifyToolAccess below since that's the real behavior. */
  description: string;
  /** Ink's standard named palette only (no hex) - yellow stands in for orange, magenta for
   * purple, since neither is in that named set. blue and white are exact matches. */
  color: string;
}

export const MODES: ModeInfo[] = [
  {
    mode: 'manual',
    label: 'Manual',
    description: 'Confirms every file write and shell command before running it.',
    color: 'white',
  },
  {
    mode: 'auto',
    label: 'Auto',
    description: 'Runs file writes and shell commands without asking.',
    color: 'yellow',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept Edits',
    description: 'Writes files automatically; still confirms shell commands.',
    color: 'magenta',
  },
  {
    mode: 'plan',
    label: 'Plan',
    description: 'Blocks file writes and shell commands outright - read-only.',
    color: 'blue',
  },
  {
    mode: 'planWrite',
    label: 'Plan-Write',
    description: 'Like Plan, but allows writing to plan documents under .o4c/plans/.',
    color: 'green',
  },
];

export function modeInfo(mode: Mode): ModeInfo {
  const info = MODES.find((m) => m.mode === mode);
  if (!info) throw new Error(`Unknown mode "${mode}"`);
  return info;
}

export type ToolAccess = 'allow' | 'confirm' | 'deny';

/**
 * The instruction actually sent to the model describing the current mode's constraints - closes
 * the real gap where a mode only affected behavior reactively, at the tool-execution gate
 * (`classifyToolAccess` below), while the model itself had no idea a restriction existed until
 * after it tried something and got a "Blocked by the current mode" result back. Telling it
 * upfront means it behaves accordingly instead of repeatedly attempting denied calls (each one a
 * wasted iteration against `run()`'s `maxIterations` budget) or a confirm prompt it can't see.
 *
 * Appended to the system prompt per-request (see `AgentLoop.run()`'s `RunOptions.modeInstruction`)
 * rather than baked into the fixed system prompt at construction time, since the mode can change
 * mid-session (via `/mode` or Tab) without restarting `AgentLoop`.
 */
export function modeSystemPrompt(mode: Mode, plansDir?: string): string {
  switch (mode) {
    case 'manual':
      return 'Current mode: Manual. Every write_file and run_shell call will pause for the ' +
        "user's explicit yes/no confirmation before it runs - expect that latency, and don't " +
        'avoid a call just because it will be confirmed.';
    case 'auto':
      return 'Current mode: Auto. write_file and run_shell both run immediately, with no ' +
        'confirmation prompt.';
    case 'acceptEdits':
      return 'Current mode: Accept Edits. write_file runs immediately with no confirmation. ' +
        "run_shell still pauses for the user's explicit yes/no confirmation before it runs.";
    case 'plan':
      return 'Current mode: Plan. write_file and run_shell are both hard-disabled - any attempt ' +
        'is refused outright, not just confirmed. Do not call either tool. Investigate and read ' +
        'only; present a plan or analysis in your final answer instead of making changes.';
    case 'planWrite':
      return plansDir
        ? `Current mode: Plan-Write. run_shell is hard-disabled - do not call it. write_file is ` +
          `only permitted for files inside ${plansDir}; a write_file call anywhere else is ` +
          'refused outright. Use write_file solely to create or update a plan document there - ' +
          'investigate and read elsewhere, but make no other changes.'
        : 'Current mode: Plan-Write, but no project is trusted yet so there is nowhere write_file ' +
          'is permitted to target. write_file and run_shell are both hard-disabled - do not call ' +
          'either. Investigate and read only; present a plan or analysis in your final answer.';
  }
}

/**
 * True when `path` (as given to write_file - absolute or relative to process.cwd(), never to
 * `plansDir` itself) resolves to somewhere inside `plansDir`. String/path math only, no I/O - the
 * target doesn't need to exist yet for a write to be in-scope.
 */
function isPlanFilePath(path: unknown, plansDir: string): boolean {
  if (typeof path !== 'string' || !path) return false;
  const rel = relative(resolve(plansDir), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/**
 * Pure decision function behind the five modes - read-only tools always run; a mutating tool's
 * access depends on the current mode. Kept separate from AgentLoop's actual tool-execution loop
 * and from App.tsx's ConfirmDialog wiring so the policy itself is trivially unit-testable.
 *
 * `input`/`plansDir` are only consulted by `planWrite` (a write_file call targeting somewhere
 * inside `plansDir`) - every other mode ignores them, so existing two-argument call sites keep
 * working unchanged. `plansDir` undefined (no trusted project) means planWrite has nowhere it's
 * allowed to write, so it denies exactly like plain `plan`.
 */
export function classifyToolAccess(
  mode: Mode,
  tool: Tool,
  input?: Record<string, unknown>,
  plansDir?: string,
): ToolAccess {
  if (!tool.mutating) return 'allow';
  switch (mode) {
    case 'plan':
      return 'deny';
    case 'planWrite':
      if (tool.name === 'write_file' && plansDir && isPlanFilePath(input?.path, plansDir)) {
        return 'allow';
      }
      return 'deny';
    case 'auto':
      return 'allow';
    case 'acceptEdits':
      return tool.name === 'write_file' ? 'allow' : 'confirm';
    case 'manual':
      return 'confirm';
  }
}
