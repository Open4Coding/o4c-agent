import { randomUUID } from 'node:crypto';
import type { Message, ToolCall } from '../providers/types.js';

/** Who produced the entry. See docs/o4c-agent-design.md §5.1/§7.3. */
export type EntryType = 'user' | 'ai' | 'system';

/** What that actor did - specific to each actor (§7.3/§7.4). `think` is split out of a raw
 * `<think>...</think>` block via `splitThinkBlock()` below (§6.6). */
export type EntrySubType =
  | 'input'
  | 'response'
  | 'think'
  | 'info'
  | 'toolcall'
  | 'toolcallresponse'
  | 'error'
  | 'session-lifecycle'
  | 'mode-change'
  | 'config-change'
  | 'provider-fallback'
  | 'background-session'
  | 'worktree'
  | 'plugin-lifecycle'
  | 'compaction'
  | 'prune';

/**
 * The single shape used both as `AgentLoop`'s live in-session history and, once §7's
 * infinite-context plugin exists, exactly the row it persists - see docs/o4c-agent-design.md
 * §5.1 for the full design and the research (opencode/pi/crush) that validated it.
 */
export interface ContextEntry {
  /** One stable id, generated at creation, never re-keyed later (validated against opencode/pi -
   * see §5.1's 2026-09-26 research note). */
  id: string;
  /** Stamped in by `SessionStore.save()` at persist time, not at creation - `AgentLoop` itself has
   * no concept of "which session this is," matching how session ids are already assigned lazily
   * (§8.1, "no session created until the first real message"). Empty string until then. */
  session_id: string;
  type: EntryType;
  sub_type: EntrySubType;
  /** Text for user/ai-response/system entries; `JSON.stringify({name, input})` for a `toolcall`
   * entry (§7.3); for a `compaction` entry, `JSON.stringify({summary, first_kept_entry_id,
   * tokens_before})` per §5.1's research note (pi's `CompactionEntry.firstKeptEntryId`). */
  content: string;
  created_at: string;
  processed_at?: string;
  model_id?: string;
  think_effort?: 'low' | 'medium' | 'high' | 'xhigh';
  input_tokens?: number;
  output_tokens?: number;
  /** Tri-state per §7.6 - undefined/null means never marked, not "incorrect." */
  is_correct?: boolean | null;
  /** §7.3 - scoped to `type='ai' && sub_type in ('toolcall','toolcallresponse')`. */
  mutating?: boolean;
  redacted?: boolean;
  retry_count?: number;
  /** How long the underlying call actually took, ms - §7.7's statistical-analysis fields
   * (pairs with `think_effort`/`is_correct` to ask "is higher effort slower, and more correct").
   * Nothing populates this yet; added now so `InfiniteContextStore` has a real field to map. */
  duration_ms?: number;
  /** Links a `toolcall` entry to its `toolcallresponse` - the one field §7's schema didn't
   * already have before this refactor (§5.1). */
  tool_call_id?: string;
  /** Resolved tag names; the real many-to-many lives in §7.5's `tags`/`entry_tags` tables once
   * that plugin exists. */
  tags?: string[];
  /** Vision input, `user`/`input` entries only. Not in §5.1's original field list - added during
   * implementation so this refactor doesn't regress existing vision support (`--image`,
   * `LocalProvider`), which predates it. */
  images?: string[];
  /** §2.3's dual-visibility design (adapted from goose's `context_mgmt/mod.rs:145-165`): once
   * compaction exists, an old entry a summary has replaced gets `agent_visible=false` (dropped
   * from `toWireMessages()`) while staying `user_visible=true` (still shown in scrollback) - one
   * list, two views, instead of a second compacted-storage concept. Undefined means true for
   * both - no entry sets these yet (compaction itself isn't built), only the plumbing is here. */
  user_visible?: boolean;
  agent_visible?: boolean;
  /** `sub_type='think'` only, Anthropic extended-thinking turns only - opaque pass-through data
   * that must round-trip back to Anthropic unmodified on any later request in this same
   * conversation (a hard API requirement once a thinking turn is followed by tool use, not just a
   * quality nicety - see `providers/types.ts`'s `Message.thinkingSignature` for the full reasoning).
   * `AgentLoop` never reads or interprets these itself, only stores and replays them. */
  thinking_signature?: string;
  /** `sub_type='think'` only - set instead of a readable `content` when Anthropic's safety system
   * redacted this particular thinking block; `content` is empty (`''`) in that case, since there
   * is nothing real to show. */
  redacted_thinking?: string;
}

/**
 * Rough token estimate for a raw string - chars/4, the same heuristic-until-a-real-tokenizer-
 * exists convention this codebase already uses elsewhere (no per-provider tokenizer is wired in).
 * The primitive `estimateTokens()` (entries) and `AgentLoop`'s own compaction-trigger overhead
 * estimate (system prompt + tool schemas, neither of which is a `ContextEntry`) both build on.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Rough token estimate for one entry - see `estimateTextTokens()`. Used to keep `AgentLoop`'s
 * running context-size estimate (§2.3's compaction trigger reads this) cheap to maintain - O(1)
 * per append instead of re-summing the whole entry log every turn.
 */
export function estimateTokens(entry: ContextEntry): number {
  return estimateTextTokens(entry.content);
}

function newEntry(partial: Omit<ContextEntry, 'id' | 'session_id' | 'created_at'>): ContextEntry {
  return {
    id: randomUUID(),
    session_id: '',
    created_at: new Date().toISOString(),
    ...partial,
  };
}

export function userInputEntry(content: string, images?: string[]): ContextEntry {
  return newEntry({ type: 'user', sub_type: 'input', content, images });
}

export function aiResponseEntry(content: string): ContextEntry {
  return newEntry({ type: 'ai', sub_type: 'response', content });
}

/** `signature`/`redactedThinking` are Anthropic-only replay data (see `ContextEntry`'s own fields
 * for why) - absent for every other provider, which just don't pass them. */
export function aiThinkEntry(content: string, signature?: string, redactedThinking?: string): ContextEntry {
  return newEntry({
    type: 'ai',
    sub_type: 'think',
    content,
    thinking_signature: signature,
    redacted_thinking: redactedThinking,
  });
}

const THINK_CLOSED = /<think>([\s\S]*?)<\/think>/i;
const THINK_UNCLOSED = /<think>([\s\S]*)/i;

/**
 * Splits a raw provider response into its `<think>...</think>` reasoning (if any) and the actual
 * response text, per direct instruction 2026-09-26. A properly closed block is captured in full,
 * however many lines it spans. An **unclosed** `<think>` (a real quirk of some local models,
 * which don't always emit the closing tag) doesn't swallow the rest of the message forever -
 * "no end needed, just a line feed": everything from `<think>` up to the first newline is taken
 * as the think content, and whatever follows that newline is treated as the real response.
 */
export function splitThinkBlock(content: string): { think?: string; response: string } {
  const closed = content.match(THINK_CLOSED);
  if (closed && closed.index !== undefined) {
    const think = closed[1].trim();
    const response = (content.slice(0, closed.index) + content.slice(closed.index + closed[0].length)).trim();
    return think ? { think, response } : { response };
  }

  const unclosed = content.match(THINK_UNCLOSED);
  if (unclosed && unclosed.index !== undefined) {
    const before = content.slice(0, unclosed.index);
    const rest = unclosed[1];
    const newlineIndex = rest.indexOf('\n');
    const think = (newlineIndex === -1 ? rest : rest.slice(0, newlineIndex)).trim();
    const after = newlineIndex === -1 ? '' : rest.slice(newlineIndex + 1);
    const response = (before + after).trim();
    return think ? { think, response } : { response };
  }

  return { response: content };
}

export function aiToolCallEntry(call: ToolCall, mutating: boolean | undefined): ContextEntry {
  return newEntry({
    type: 'ai',
    sub_type: 'toolcall',
    content: JSON.stringify({ name: call.name, input: call.input }),
    tool_call_id: call.id,
    mutating,
  });
}

export function aiToolCallResponseEntry(
  callId: string,
  output: string,
  mutating: boolean | undefined,
): ContextEntry {
  return newEntry({
    type: 'ai',
    sub_type: 'toolcallresponse',
    content: output,
    tool_call_id: callId,
    mutating,
  });
}

/**
 * The entry a real compaction pass (§2.3, `agent/compaction.ts`) inserts in place of the older
 * entries it replaces - `type: 'ai'` (not `system`) specifically so `toWireMessages()` bundles it
 * into a normal assistant message the model actually sees, matching how opencode's own compaction
 * inserts its summary as an assistant-role message (verified directly against its source before
 * choosing this over a `system`-typed entry, which `toWireMessages()` always skips). `content` is
 * `JSON.stringify({summary, first_kept_entry_id, tokens_before})`, per §5.1's original research
 * note (matches pi's `CompactionEntry.firstKeptEntryId`) - `summary` itself is the structured
 * object `compaction.ts`'s `parseSummary()` produces, not free text.
 */
export function aiCompactionEntry(
  summary: unknown,
  firstKeptEntryId: string | undefined,
  tokensBefore: number,
): ContextEntry {
  return newEntry({
    type: 'ai',
    sub_type: 'compaction',
    content: JSON.stringify({ summary, first_kept_entry_id: firstKeptEntryId, tokens_before: tokensBefore }),
  });
}

/**
 * §2.3's MicroCompact tier (2026-09-28, `cc`/hermes-agent-derived: a free, no-API-call tier
 * cheaper than a real `compaction` summary) inserts one of these per pass, right after hiding
 * whichever old `toolcall`/`toolcallresponse` pairs it found - same append-and-flip mechanism
 * `aiCompactionEntry` already uses (codex's no-history-rewrite constraint), reused here rather
 * than mutating the pruned entries' own content in place. Unlike a compaction summary, there is
 * nothing to summarize - a fixed-template line is all this needs, so `content` is plain text, not
 * a JSON shape a wire-formatter has to unpack.
 */
export function aiPruneEntry(prunedPairCount: number, tokensFreed: number): ContextEntry {
  return newEntry({
    type: 'ai',
    sub_type: 'prune',
    content: `[${prunedPairCount} older tool call${prunedPairCount === 1 ? '' : 's'} pruned from context (~${tokensFreed} tokens freed) - still visible in scrollback and the run log]`,
  });
}

/**
 * Projects the full entry log down to exactly what a provider needs for one request - the same
 * `Message[]` wire format every provider already accepts unchanged (§4.2's abstraction needs no
 * changes because of this refactor).
 *
 * Regroups each provider response's own entries back into one assistant message: `AgentLoop.run()`
 * always logs one `response` entry per provider call (even with empty content) followed by zero or
 * more `toolcall` entries from that same call, but the real wire format bundles text and tool_use
 * blocks into a single assistant message - splitting them into separate, individually-taggable
 * entries for §7's searchability loses that grouping, so it's rebuilt here. A `toolcallresponse`
 * entry always closes the group it belongs to (a tool result can never continue an assistant
 * message). `system`-type entries are harness-internal bookkeeping, never sent to the model, and
 * are skipped entirely.
 */
/** Renders a `compaction` entry's stored `{summary, first_kept_entry_id, tokens_before}` JSON
 * (§5.1's documented content shape) into the prose block the model actually sees in place of the
 * entries it replaced - the structured object stays queryable in `content` for `/debug`/
 * `search_history` (per that same note), this is only the wire-projection view. Falls back to the
 * raw content on any parse failure (goose's own "deserialize leniently" principle - a malformed
 * compaction entry should degrade, not crash `toWireMessages()`). */
function formatCompactionForWire(content: string): string {
  let parsed: { summary?: unknown };
  try {
    parsed = JSON.parse(content) as { summary?: unknown };
  } catch {
    return content;
  }
  const summary = parsed.summary;
  if (!summary || typeof summary !== 'object') return content;
  const s = summary as Record<string, unknown>;
  const lines = ['[Earlier conversation summary - older messages were compacted to save context]', ''];
  const field = (label: string, key: string) => {
    const value = s[key];
    if (value === undefined || value === null || value === '') return;
    lines.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  };
  field('Goal', 'user_intent');
  field('Technical concepts', 'technical_concepts');
  if (Array.isArray(s.files) && s.files.length > 0) {
    lines.push('Files:');
    for (const f of s.files) {
      if (f && typeof f === 'object') {
        const file = f as Record<string, unknown>;
        lines.push(`- ${file.path ?? '?'}: ${file.summary ?? ''}`);
      }
    }
  }
  field('Errors & fixes', 'errors_and_fixes');
  field('Problem solving', 'problem_solving');
  field('Pending tasks', 'pending_tasks');
  field('Current work', 'current_work');
  field('Next step', 'next_step');
  return lines.join('\n');
}

export function toWireMessages(entries: readonly ContextEntry[]): Message[] {
  const messages: Message[] = [];
  let pending: {
    content: string;
    toolCalls: ToolCall[];
    thinkingText?: string;
    thinkingSignature?: string;
    redactedThinking?: string;
  } | null = null;

  function flush(): void {
    if (!pending) return;
    messages.push({
      role: 'assistant',
      content: pending.content,
      toolCalls: pending.toolCalls.length > 0 ? pending.toolCalls : undefined,
      // Only present at all when a thinking turn actually set one - keeps the overwhelmingly
      // common (non-thinking) case's wire Message exactly as small as it always was, not padded
      // with three always-undefined keys.
      ...(pending.thinkingText !== undefined ? { thinkingText: pending.thinkingText } : {}),
      ...(pending.thinkingSignature !== undefined ? { thinkingSignature: pending.thinkingSignature } : {}),
      ...(pending.redactedThinking !== undefined ? { redactedThinking: pending.redactedThinking } : {}),
    });
    pending = null;
  }

  for (const entry of entries) {
    if (entry.type === 'system') continue;
    // §2.3's dual-visibility flag - an entry a compaction summary has replaced is dropped from
    // what the model sees, but stays in `entries` (and scrollback) unchanged. No entry sets this
    // yet, so this is a no-op today; the check is here so compaction needs zero changes to this
    // function once it exists.
    if (entry.agent_visible === false) continue;

    if (entry.type === 'user' && entry.sub_type === 'input') {
      flush();
      messages.push({ role: 'user', content: entry.content, images: entry.images });
      continue;
    }

    if (
      entry.type === 'ai' &&
      (entry.sub_type === 'response' ||
        entry.sub_type === 'info' ||
        entry.sub_type === 'think' ||
        entry.sub_type === 'compaction' ||
        entry.sub_type === 'prune')
    ) {
      const text = entry.sub_type === 'compaction' ? formatCompactionForWire(entry.content) : entry.content;
      if (!pending) pending = { content: text, toolCalls: [] };
      // A `think` entry followed by its own `response` entry (§6.6's split) need a separator so
      // the two don't run together word-to-word - blank-line join, same convention as joining any
      // other two logically distinct text segments in this codebase (e.g. modeInstruction's own
      // append onto the system prompt in loop.ts).
      else if (pending.content && text) pending.content += `\n\n${text}`;
      else pending.content += text;
      if (entry.sub_type === 'think') {
        // Kept separate from the merged `content` above - Anthropic's replay needs the raw
        // thinking text and its signature reassembled into their own distinct content block, not
        // folded into the response text (see Message.thinkingText's own doc comment). thinkingText
        // is only meaningful paired with its signature (a `ThinkingBlockParam` needs both, per
        // Anthropic's own type) - set only when there's actually a signature to pair it with, so a
        // plain (non-Anthropic, unsigned) think entry's wire Message stays exactly as small as it
        // always was, same reasoning as flush()'s own conditional spread below.
        if (entry.thinking_signature) {
          pending.thinkingText = entry.content;
          pending.thinkingSignature = entry.thinking_signature;
        }
        if (entry.redacted_thinking) {
          pending.redactedThinking = entry.redacted_thinking;
        }
      }
      continue;
    }

    if (entry.type === 'ai' && entry.sub_type === 'toolcall') {
      if (!pending) pending = { content: '', toolCalls: [] };
      const parsed = JSON.parse(entry.content) as { name: string; input: Record<string, unknown> };
      pending.toolCalls.push({ id: entry.tool_call_id ?? entry.id, name: parsed.name, input: parsed.input });
      continue;
    }

    if (entry.type === 'ai' && entry.sub_type === 'toolcallresponse') {
      flush();
      messages.push({ role: 'tool', content: entry.content, toolCallId: entry.tool_call_id ?? entry.id });
      continue;
    }
  }
  flush();

  return messages;
}

/**
 * Lifts an old, plain `Message[]` (as saved by session files before this refactor) into minimal
 * `ContextEntry` objects - a one-way upgrade path, not a migration that needs to run anywhere
 * (§5.1). `type`/`sub_type` inferred from `role`; every field this refactor added beyond `Message`
 * is left unset, since that information genuinely wasn't tracked before.
 */
export function liftLegacyMessages(messages: readonly Message[]): ContextEntry[] {
  return messages.flatMap((m): ContextEntry[] => {
    if (m.role === 'user') {
      return [newEntry({ type: 'user', sub_type: 'input', content: m.content, images: m.images })];
    }
    if (m.role === 'tool') {
      return [
        newEntry({
          type: 'ai',
          sub_type: 'toolcallresponse',
          content: m.content,
          tool_call_id: m.toolCallId,
        }),
      ];
    }
    // assistant
    const out: ContextEntry[] = [];
    if (m.content) out.push(newEntry({ type: 'ai', sub_type: 'response', content: m.content }));
    for (const call of m.toolCalls ?? []) {
      out.push(
        newEntry({
          type: 'ai',
          sub_type: 'toolcall',
          content: JSON.stringify({ name: call.name, input: call.input }),
          tool_call_id: call.id,
        }),
      );
    }
    return out;
  });
}
