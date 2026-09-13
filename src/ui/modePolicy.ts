import type { Tool } from '../tools/types.js';

export type Mode = 'manual' | 'auto' | 'acceptEdits' | 'plan';

export interface ModeInfo {
  mode: Mode;
  label: string;
  /** Ink's standard named palette only (no hex) - yellow stands in for orange, magenta for
   * purple, since neither is in that named set. blue and white are exact matches. */
  color: string;
}

export const MODES: ModeInfo[] = [
  { mode: 'manual', label: 'Manual', color: 'white' },
  { mode: 'auto', label: 'Auto', color: 'yellow' },
  { mode: 'acceptEdits', label: 'Accept Edits', color: 'magenta' },
  { mode: 'plan', label: 'Plan', color: 'blue' },
];

export function modeInfo(mode: Mode): ModeInfo {
  const info = MODES.find((m) => m.mode === mode);
  if (!info) throw new Error(`Unknown mode "${mode}"`);
  return info;
}

export type ToolAccess = 'allow' | 'confirm' | 'deny';

/**
 * Pure decision function behind the four modes - read-only tools always run; a mutating tool's
 * access depends on the current mode. Kept separate from AgentLoop's actual tool-execution loop
 * and from App.tsx's ConfirmDialog wiring so the policy itself is trivially unit-testable.
 */
export function classifyToolAccess(mode: Mode, tool: Tool): ToolAccess {
  if (!tool.mutating) return 'allow';
  switch (mode) {
    case 'plan':
      return 'deny';
    case 'auto':
      return 'allow';
    case 'acceptEdits':
      return tool.name === 'write_file' ? 'allow' : 'confirm';
    case 'manual':
      return 'confirm';
  }
}
