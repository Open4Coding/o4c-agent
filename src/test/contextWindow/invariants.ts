import type { ContextEntry } from '../../agent/contextEntry.js';
import type { Message, ToolDefinition } from '../../providers/types.js';

export interface Finding {
  invariant: string;
  detail: string;
}

export interface Violation extends Finding {
  step: number;
}

const RELEASED_MARKER = /content released from memory after compaction\]$/;
const TAG_GLOBAL = /\[\[E\d+\]\]/g;
const MIN_MAX_TOKENS = 256;
const ABSOLUTE_MAX_TOKENS = 32768;

/** What the server would count for this request if its tokenizer disagreed with chars/4 by `drift`. */
export function promptTokens(
  req: { systemPrompt?: string; tools: ToolDefinition[]; messages: readonly Message[] },
  drift: number,
): number {
  let chars = (req.systemPrompt ?? '').length + JSON.stringify(req.tools).length;
  for (const m of req.messages) {
    chars += m.content.length;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil((chars / 4) * drift);
}

export function wireFindings(messages: readonly Message[]): Finding[] {
  const out: Finding[] = [];
  let open = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      const id = m.toolCallId ?? '';
      if (!open.has(id)) {
        out.push({ invariant: 'tool-result-has-call', detail: `message ${i} answers call ${id}, which is not open` });
      }
      open.delete(id);
      return;
    }
    if (open.size > 0) {
      out.push({ invariant: 'call-has-result', detail: `message ${i} follows unanswered call(s) ${[...open].join(', ')}` });
      open = new Set();
    }
    if (m.role === 'assistant' && m.toolCalls) {
      for (const call of m.toolCalls) open.add(call.id);
    }
  });
  if (open.size > 0) {
    out.push({ invariant: 'call-has-result', detail: `request ends with unanswered call(s) ${[...open].join(', ')}` });
  }
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    out.push({ invariant: 'ends-on-user-or-tool', detail: 'request ends on an assistant message' });
  }
  return out;
}

export function entryFindings(entries: readonly ContextEntry[], visibleEstimate: number): Finding[] {
  const out: Finding[] = [];
  let recount = 0;
  for (const entry of entries) {
    if (entry.agent_visible === false) continue;
    recount += Math.ceil(entry.content.length / 4);
    if (RELEASED_MARKER.test(entry.content)) {
      out.push({ invariant: 'released-is-hidden', detail: `entry ${entry.id} is released but still visible` });
    }
  }
  if (recount !== visibleEstimate) {
    out.push({
      invariant: 'visible-estimate-matches-recount',
      detail: `running counter ${visibleEstimate}, full recount ${recount}`,
    });
  }
  return out;
}

export function maxTokensFindings(maxTokens: number | undefined, window: number): Finding[] {
  if (maxTokens === undefined) {
    return [{ invariant: 'max-tokens-set', detail: 'request has no maxTokens although a window is set' }];
  }
  const hi = Math.min(ABSOLUTE_MAX_TOKENS, Math.floor(window / 4));
  if (maxTokens < MIN_MAX_TOKENS || maxTokens > hi) {
    return [
      {
        invariant: 'max-tokens-in-range',
        detail: `maxTokens ${maxTokens} outside [${MIN_MAX_TOKENS}, ${hi}] for window ${window}`,
      },
    ];
  }
  return [];
}

export function windowFindings(prompt: number, maxTokens: number | undefined, window: number): Finding[] {
  const out: Finding[] = [];
  if (prompt > window) {
    out.push({ invariant: 'prompt-fits-window', detail: `prompt ~${prompt} tokens exceeds window ${window}` });
  }
  if (maxTokens !== undefined && prompt + maxTokens > window) {
    out.push({
      invariant: 'prompt-plus-max-fits-window',
      detail: `prompt ~${prompt} + maxTokens ${maxTokens} exceeds window ${window}`,
    });
  }
  return out;
}

/** A hidden entry's content must never reach the wire. Matched by the unique tag each entry carries. */
export function forbiddenFindings(messages: readonly Message[], hiddenTags: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  if (hiddenTags.size === 0) return out;
  messages.forEach((m, i) => {
    const text = m.toolCalls ? m.content + JSON.stringify(m.toolCalls) : m.content;
    for (const hit of text.matchAll(TAG_GLOBAL)) {
      if (hiddenTags.has(hit[0])) {
        out.push({ invariant: 'hidden-never-sent', detail: `message ${i} carries hidden entry ${hit[0]}` });
      }
    }
  });
  return out;
}
