/**
 * `/status` (plan 0006 E2): the session's setup and health on one screen - what model and server,
 * how full the context is, how well the cache is doing, and which of o4c's own features are on.
 * No model call; everything is already known locally.
 */
export interface StatusInput {
  model: string;
  provider: string;
  contextWindow?: number;
  contextUsed: number;
  cachePercent?: number;
  lastPrefillMs?: number;
  draftAcceptPercent?: number;
  lastCacheBreak?: string;
  instructionFiles: string[];
  promptProfile?: string;
  thinkLevel: string;
  sampling: string;
  shell: string;
  mcp: string[];
  checkpoints: boolean;
  memories: number;
  permissionRules: number;
}

const pct = (n: number | undefined) => (n === undefined ? 'n/a' : `${n}%`);

export function formatStatus(s: StatusInput): string[] {
  const window = s.contextWindow ? ` of ${s.contextWindow.toLocaleString()} (${Math.round((s.contextUsed / s.contextWindow) * 100)}%)` : ' (window size unknown)';
  return [
    'Status (local, no model call):',
    `  Model:        ${s.model} via ${s.provider}`,
    `  Context:      ~${s.contextUsed.toLocaleString()} tokens${window}`,
    `  Cache:        ${pct(s.cachePercent)} of prompt tokens served from cache this session${s.lastPrefillMs !== undefined ? `; last prefill ${(s.lastPrefillMs / 1000).toFixed(1)} s` : ''}`,
    ...(s.draftAcceptPercent !== undefined ? [`  Drafting:     ${s.draftAcceptPercent}% of drafted tokens accepted (MTP / n-gram)`] : []),
    ...(s.lastCacheBreak ? [`  Cache break:  ${s.lastCacheBreak}`] : []),
    `  Instructions: ${s.instructionFiles.length ? s.instructionFiles.join(', ') : 'none (o4c.md, AGENTS.md or CLAUDE.md - /init writes one)'}`,
    `  Prompt:       profile ${s.promptProfile ?? 'n/a'} (/view-prompt)`,
    `  Thinking:     ${s.thinkLevel} (/think); sampling ${s.sampling}`,
    `  Shell:        ${s.shell} (/set-shell)`,
    `  MCP:          ${s.mcp.length ? s.mcp.join('; ') : 'no servers'}`,
    `  Checkpoints:  ${s.checkpoints ? 'on (/undo, /rewind, /diff)' : 'off'}`,
    `  Memory:       ${s.memories} item(s) (/memory)`,
    `  Permissions:  ${s.permissionRules ? `${s.permissionRules} rule(s) (/view-permissions)` : 'no rules - modes decide (/view-permissions)'}`,
  ];
}
