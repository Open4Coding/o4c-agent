import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ToolDefinition } from '../providers/types.js';

/**
 * `/debug` (plan 0006 L3, answered Q7 = c): o4c debugging itself - exactly what the model was sent
 * and why, written to a file and opened in the user's editor. Not a program debugger.
 *
 * Where the last request comes from: this process's own last call when it made one, otherwise the
 * newest FULLCONTEXT log. o4c reloads into a fresh process after most turns, so right after a turn
 * the log is usually the only place the request still exists. That log holds one full
 * `provider_call` and then `provider_call_delta`s (new messages; system prompt and tools only when
 * they changed), so the last request is rebuilt by replaying them.
 */
export interface LoggedRequest {
  systemPrompt?: string;
  messages: Message[];
  tools: ToolDefinition[];
  response?: unknown;
}

/** The last request a FULLCONTEXT log describes, rebuilt from its full call and the deltas after it. */
export function lastRequestFromLog(jsonl: string): LoggedRequest | undefined {
  let current: LoggedRequest | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type === 'provider_call') {
      const req = (e.request ?? {}) as { systemPrompt?: string; messages?: Message[]; tools?: ToolDefinition[] };
      current = { systemPrompt: req.systemPrompt, messages: [...(req.messages ?? [])], tools: req.tools ?? [], response: e.response };
    } else if (e.type === 'provider_call_delta' && current) {
      current = {
        systemPrompt: typeof e.systemPrompt === 'string' ? e.systemPrompt : current.systemPrompt,
        tools: Array.isArray(e.tools) ? (e.tools as ToolDefinition[]) : current.tools,
        messages: [...current.messages, ...((e.messages as Message[] | undefined) ?? [])],
        response: e.response,
      };
    }
  }
  return current;
}

/** The newest FULLCONTEXT log in `dir` that has a request in it. */
export function lastRequestFromLogs(dir: string): { request: LoggedRequest; file: string } | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.FULLCONTEXT.jsonl')).sort().reverse();
  } catch {
    return undefined;
  }
  for (const n of names.slice(0, 20)) {
    try {
      const request = lastRequestFromLog(readFileSync(join(dir, n), 'utf-8'));
      if (request) return { request, file: join(dir, n) };
    } catch {
      // Unreadable - try the next one.
    }
  }
  return undefined;
}

export interface DebugInput {
  request: LoggedRequest;
  source: string;
  /** `/context`'s breakdown of that request, already formatted. */
  breakdown: string[];
  window: string;
  historyEntries: number;
  cacheBreak?: string;
  rules: string[];
  model: string;
  thinkLevel: string;
}

function messageText(m: Message): string {
  const parts: string[] = [];
  if (m.content) parts.push(m.content);
  const calls = (m as unknown as { toolCalls?: unknown[] }).toolCalls;
  if (Array.isArray(calls) && calls.length) parts.push(`tool calls:\n${JSON.stringify(calls, null, 2)}`);
  return parts.join('\n\n') || '(empty)';
}

/** The whole dump as Markdown: the "why" first, then the exact request, then the raw response. */
export function formatDebugDump(d: DebugInput, now = new Date()): string {
  const r = d.request;
  const lastUser = [...r.messages].reverse().find((m) => m.role === 'user');
  const out = [
    `# o4c /debug - ${now.toISOString()}`,
    '',
    `Request source: ${d.source}`,
    `Model: ${d.model}; thinking: ${d.thinkLevel}`,
    '',
    '## Why - what went into the last request',
    '',
    '```',
    ...d.breakdown,
    '```',
    '',
    `- Window: ${d.window}; ${r.messages.length} messages sent, ${d.historyEntries} entries in the session's history`,
    `- Last cache break: ${d.cacheBreak ?? 'none recorded in this process'}`,
    `- Tools offered: ${r.tools.length} (${r.tools.map((t) => t.name).join(', ')})`,
    '- Permission rules:',
    ...(d.rules.length ? d.rules.map((l) => `  ${l}`) : ['  none']),
    '',
    '### The last user message as sent (turn notes, steering and `!` output are folded in here)',
    '',
    '```',
    lastUser ? messageText(lastUser) : '(none)',
    '```',
    '',
    '## System prompt (exact)',
    '',
    '```',
    r.systemPrompt ?? '(none)',
    '```',
    '',
    `## Messages (exact, ${r.messages.length})`,
    '',
  ];
  r.messages.forEach((m, i) => {
    out.push(`### [${i}] ${m.role}`, '', '```', messageText(m), '```', '');
  });
  out.push('## Tools (exact)', '', '```json', JSON.stringify(r.tools, null, 2), '```', '', '## Response (raw)', '', '```json', JSON.stringify(r.response ?? null, null, 2), '```', '');
  return out.join('\n');
}
