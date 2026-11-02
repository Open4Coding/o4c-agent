import type { Message, ToolDefinition } from '../providers/types.js';
import { estimateTextTokens } from './contextEntry.js';
import type { PromptSection } from './systemPrompt.js';

/**
 * Where a request's tokens go (plan 0006 D5, `/context`): the system prompt by section, tool
 * schemas (built-in, MCP, others), and the messages by kind - user, model text, tool calls, tool
 * results - with the current turn (everything since the last user message) shown on its own.
 * Estimates (chars/4), like every other figure /context shows before the server has counted.
 */
export interface Bucket {
  label: string;
  tokens: number;
  /** Indented under the previous top-level bucket. */
  sub?: boolean;
}

const BUILT_IN = new Set(['read_file', 'write_file', 'edit_file', 'run_shell', 'glob_files', 'grep_files', 'job_output', 'ask_user']);

function messageText(m: Message): string {
  const calls = (m.toolCalls ?? []).map((c) => JSON.stringify({ name: c.name, input: c.input })).join('');
  return `${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}${m.reasoning ?? ''}${calls}`;
}

export function contextBreakdown(request: { systemPrompt: string; messages: readonly Message[]; tools: readonly ToolDefinition[] }, sections?: readonly PromptSection[]): Bucket[] {
  const out: Bucket[] = [];
  out.push({ label: 'System prompt', tokens: estimateTextTokens(request.systemPrompt) });
  if (sections?.length) {
    const core = sections.filter((s) => s.name !== 'environment' && s.name !== 'project');
    const pick = (name: string) => sections.find((s) => s.name === name);
    out.push({ label: 'o4c rules and tool guidance', tokens: core.reduce((n, s) => n + estimateTextTokens(s.text), 0), sub: true });
    if (pick('environment')) out.push({ label: 'environment (directory, shell)', tokens: estimateTextTokens(pick('environment')!.text), sub: true });
    if (pick('project')) out.push({ label: 'project instructions (O4C.md / AGENTS.md)', tokens: estimateTextTokens(pick('project')!.text), sub: true });
  }

  const toolTokens = (defs: readonly ToolDefinition[]) => defs.reduce((n, d) => n + estimateTextTokens(JSON.stringify({ name: d.name, description: d.description, input_schema: d.inputSchema })), 0);
  const builtIn = request.tools.filter((t) => BUILT_IN.has(t.name));
  const mcp = request.tools.filter((t) => t.name.startsWith('mcp__'));
  const other = request.tools.filter((t) => !BUILT_IN.has(t.name) && !t.name.startsWith('mcp__'));
  out.push({ label: `Tool schemas (${request.tools.length} tools)`, tokens: toolTokens(request.tools) });
  out.push({ label: `built-in (${builtIn.length})`, tokens: toolTokens(builtIn), sub: true });
  if (other.length) out.push({ label: `o4c features (${other.map((t) => t.name).join(', ')})`, tokens: toolTokens(other), sub: true });
  if (mcp.length) out.push({ label: `MCP servers (${mcp.length})`, tokens: toolTokens(mcp), sub: true });

  const lastUser = request.messages.map((m) => m.role).lastIndexOf('user');
  const history = lastUser > 0 ? request.messages.slice(0, lastUser) : [];
  const current = lastUser >= 0 ? request.messages.slice(lastUser) : request.messages;
  const kinds = (ms: readonly Message[]) => {
    const sum = { user: 0, text: 0, calls: 0, results: 0 };
    for (const m of ms) {
      if (m.role === 'user') sum.user += estimateTextTokens(messageText(m));
      else if (m.role === 'tool') sum.results += estimateTextTokens(messageText(m));
      else {
        sum.text += estimateTextTokens(`${typeof m.content === 'string' ? m.content : ''}${m.reasoning ?? ''}`);
        sum.calls += estimateTextTokens((m.toolCalls ?? []).map((c) => JSON.stringify({ name: c.name, input: c.input })).join(''));
      }
    }
    return sum;
  };
  const h = kinds(history);
  out.push({ label: `Earlier conversation (${history.length} messages)`, tokens: h.user + h.text + h.calls + h.results });
  if (history.length) {
    out.push({ label: 'your messages (with notes o4c added)', tokens: h.user, sub: true });
    out.push({ label: 'model replies and reasoning', tokens: h.text, sub: true });
    out.push({ label: 'tool calls', tokens: h.calls, sub: true });
    out.push({ label: 'tool results', tokens: h.results, sub: true });
  }
  const c = kinds(current);
  out.push({ label: `Current turn (${current.length} messages)`, tokens: c.user + c.text + c.calls + c.results });
  return out;
}

export function formatBreakdown(buckets: readonly Bucket[]): string[] {
  const total = buckets.filter((b) => !b.sub).reduce((n, b) => n + b.tokens, 0);
  const lines = buckets.map((b) => {
    const pct = total ? ` ${Math.round((b.tokens / total) * 100)}%` : '';
    return b.sub ? `      ${b.label}: ${b.tokens.toLocaleString()}` : `    ${b.label}: ${b.tokens.toLocaleString()}${pct}`;
  });
  return [`  Where the tokens go (estimated, ${total.toLocaleString()} in all):`, ...lines];
}
