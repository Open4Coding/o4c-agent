import type { CompletionRequest, Message, Usage } from '../providers/types.js';

/**
 * Prompt-cache break detection (plan 0006 A2). llama-server reuses only an exact token prefix,
 * and on a hybrid recurrent model like Qwen3.8 any change mid-history costs a re-process from the
 * nearest checkpoint (research report 10, section 0.2). A1 made the cost visible; this names the
 * cause, by comparing each main request with the one before it rather than by trusting every
 * code path to report what it changed:
 *
 * - `system prompt` - the system text differs (mode note, instructions, environment).
 * - `tools`         - the tool list differs (an MCP server connected, the graph switched).
 * - `history`       - an earlier message differs (window slide, compaction, a rewritten note);
 *                     `at` says which message.
 * - `evicted`       - the request only appended, yet the cache missed: something else used the
 *                     server's slot in between (a side call, another client), or it restarted.
 */

export type CacheBreakReason = 'system prompt' | 'tools' | 'history' | 'evicted';

export interface CacheBreak {
  reason: CacheBreakReason;
  /** `history` only: index of the first message that differs. */
  at?: number;
  /** Prompt tokens the previous request ended with (what could have been reused). */
  expected: number;
  /** Prompt tokens the server actually reused this time. */
  cached: number;
}

/** A miss below this share of the reusable prefix counts as a break; above it is normal jitter
 * (the template re-renders the last assistant turn's tail, a few tokens). */
export const CACHE_BREAK_RATIO = 0.9;

function sameMessage(a: Message, b: Message): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toolNames(request: CompletionRequest): string {
  return JSON.stringify((request.tools ?? []).map((t) => [t.name, t.description, t.inputSchema]));
}

/** Index of the first message of `prev` that `next` does not carry unchanged, or -1 when `next`
 * starts with all of `prev`. The last message of `prev` is allowed to differ (the assistant reply
 * that followed it is appended as a new message, and a continuation may extend it). */
export function firstDivergence(prev: readonly Message[], next: readonly Message[]): number {
  const n = Math.min(prev.length - 1, next.length);
  for (let i = 0; i < n; i++) if (!sameMessage(prev[i]!, next[i]!)) return i;
  return next.length < prev.length - 1 ? next.length : -1;
}

/**
 * Whether `request` broke the cache, and why. `previous` is the last main request and
 * `previousPromptTokens` its prompt size (cached + processed). Undefined when there was no previous
 * request, when the server did not report `cachedTokens`, or when the cache held.
 */
export function diagnoseCacheBreak(
  previous: CompletionRequest | undefined,
  previousPromptTokens: number | undefined,
  request: CompletionRequest,
  usage: Usage | undefined,
): CacheBreak | undefined {
  if (!previous || !previousPromptTokens || usage?.cachedTokens === undefined) return undefined;
  const expected = previousPromptTokens;
  const cached = usage.cachedTokens;
  if (cached >= CACHE_BREAK_RATIO * expected) return undefined;
  if (previous.systemPrompt !== request.systemPrompt) return { reason: 'system prompt', expected, cached };
  if (toolNames(previous) !== toolNames(request)) return { reason: 'tools', expected, cached };
  const at = firstDivergence(previous.messages, request.messages);
  if (at >= 0) return { reason: 'history', at, expected, cached };
  return { reason: 'evicted', expected, cached };
}

/** One line for the run log and `/context`. */
export function describeCacheBreak(b: CacheBreak): string {
  const where = b.reason === 'history' ? ` (message ${b.at})` : '';
  return `cache break: ${b.reason}${where} - reused ${b.cached} of ${b.expected} prompt tokens`;
}
