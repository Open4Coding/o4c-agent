import type { ThinkLevel } from '../agent/thinkLevel.js';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  images?: string[];
  /**
   * `role: 'assistant'` only: the model's reasoning for this message, apart from `content` (plan
   * 0006 A7). It used to be merged into `content` as plain text, so the local server saw a reply
   * that differed from what it generated (re-processing it every tool round) and every past turn's
   * reasoning was re-sent forever as if it were the answer. Providers decide what to do with it:
   * the local one sends it as `reasoning_content` for the current turn only.
   */
  reasoning?: string;
  /** `role: 'assistant'` only, and only when extended thinking was used for that turn - the raw
   * thinking text, kept *separate* from `content` (which merges think+response into one display
   * string, per `toWireMessages()`) specifically because Anthropic's replay requirement needs the
   * thinking text and its `thinkingSignature` reassembled into their own distinct content block,
   * not folded into the response text. Other providers ignore this field entirely. */
  thinkingText?: string;
  /** Pass this exact value back to Anthropic, unmodified, when replaying a `thinking` block - a
   * hard API requirement whenever a thinking turn is followed by tool use (the common case in an
   * agentic loop), not just a quality nicety. Never fabricate or omit-when-present: a missing or
   * altered signature on a turn that needs one is a 400 `invalid_request_error` from Anthropic,
   * not a silent degradation. */
  thinkingSignature?: string;
  /** Pass this exact opaque value back unmodified when replaying a `redacted_thinking` block
   * (Anthropic's safety system withheld the actual reasoning) - there is no readable text for
   * this case, `thinkingText`/`thinkingSignature` are absent whenever this is set. */
  redactedThinking?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  systemPrompt?: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** Real bug found via direct reproduction (2026-10-03): LocalProvider's own `max_tokens` used to
   * be a single static value (half the context window, set once at startup) - fine for a short
   * prompt, but for anything else `prompt + maxTokens` can exceed the server's real `n_ctx` before
   * the model ever reaches that cap, so the SERVER truncates mid-generation instead (confirmed
   * live: a single response ran 9+ minutes generating 16,289 tokens straight before the server cut
   * it off at `n_ctx` with `truncated: 1` - not a clean stop). When set, this overrides the
   * provider's own static default with a per-request budget computed from the actual prompt size
   * about to be sent (loop.ts, right before each call) - optional so a provider without this
   * problem (Anthropic's cloud context dwarfs anything a single agent turn could approach) can
   * simply ignore it. */
  maxTokens?: number;
  /** `'none'`: tools stay listed (so the request's prefix matches the conversation's and the server
   * reuses its cache) but the model must not call one - the cache-sharing compaction call, plan
   * 0006 A11. Providers that cannot express it ignore it. */
  toolChoice?: 'none';
  /**
   * Constrained output for side calls (plan 0006 A12): a JSON schema the reply must match, or a
   * GBNF grammar. Sent by the local provider only (llama-server's `response_format` / `grammar`);
   * others ignore them, and the callers keep their tolerant parsers for that case.
   */
  responseSchema?: Record<string, unknown>;
  grammar?: string;
  /** Lets the caller cancel an in-flight request (e.g. the user pressed Escape while the
   * "Thinking..." spinner was showing). Providers that make a real network call should pass it
   * straight through to that call's own cancellation mechanism. */
  signal?: AbortSignal;
  /** Called with each raw text chunk as it streams in, if the provider supports streaming (both
   * real providers do). Purely a live-preview signal - not a replacement for the final
   * `CompletionResponse.content` this call still resolves to once the stream ends. Optional so a
   * caller that doesn't care about live preview (or MockProvider in tests) can just ignore it -
   * every provider must still fully resolve `complete()` normally either way.
   *
   * `kind` says whether this chunk is reasoning ("think") or the final answer ("text") - both
   * real providers already know this per-chunk at the source (LocalProvider branches on
   * `reasoning_content` vs `content`; Anthropic's SDK fires distinct `'thinking'`/`'text'` stream
   * events), so this is a direct signal, not a guess reconstructed from the complete text later. */
  onToken?: (delta: string, kind: 'think' | 'text') => void;
  /**
   * Called as a tool call's arguments stream in, with the tool's name and how many characters of
   * arguments have arrived so far (NextUp item 43). A `write_file` carries the whole file in its
   * arguments, so a model writing a 13K-character page spends a minute or more generating them -
   * with nothing to stream to `onToken`, that minute looked like the model had gone silent, which
   * was reported as thinking not being shown. Optional, like `onToken`.
   */
  onToolProgress?: (toolName: string, argumentChars: number) => void;
  /**
   * How much reasoning this request is allowed, from `/think` (see `agent/thinkLevel.ts`).
   *
   * Per-request rather than fixed on the provider, because the whole point is that `/think` takes
   * effect on the very next turn with no restart - llama-server's own `--reasoning-effort` and
   * `--reasoning-budget` are launch flags and could never back a live setting. Each provider
   * translates it with `thinkLevel.ts`'s helpers and omits whatever its model cannot honour (an
   * unsupported effort string is not harmless: the chat template raises and the request 500s). A
   * provider with no reasoning control ignores this field.
   */
  thinkLevel?: ThinkLevel;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

/** Token counts for one completion request, as reported by the provider itself - not estimated. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Decode throughput in tokens/second - generation only, with prefill excluded, which is the
   * number worth watching while a turn runs (prefill is a one-off and its rate says nothing about
   * how fast the answer is arriving).
   *
   * llama.cpp reports it directly as `timings.predicted_per_second`, in both the non-streaming
   * response and the final streaming chunk (measured 45.97-50.39 on PHOEBE's dual-3090 Qwen3), so
   * for the local provider this is the server's own figure rather than a client-side guess.
   * Anthropic reports no equivalent, so there it is computed from output tokens over generation
   * time. Optional: absent until a response has actually completed, and absent from any provider
   * that reports neither.
   */
  tokensPerSecond?: number;
  /**
   * Prompt tokens the server served from its prompt cache instead of processing again
   * (llama.cpp `timings.cache_n`, Anthropic `cache_read_input_tokens`). With
   * `processedPromptTokens` it is the only way to see whether the cache is working - a measured 8 h
   * run was 94% prompt tokens, and how many of those were re-processed was unknowable (plan 0006
   * item A1). Optional and never fabricated: absent when the provider does not say.
   */
  cachedTokens?: number;
  /** Prompt tokens actually processed (prefilled) for this request (`timings.prompt_n`). */
  processedPromptTokens?: number;
  /** Time spent processing them, in ms (`timings.prompt_ms`). */
  prefillMs?: number;
  /** Speculative-decoding tokens drafted and accepted (`timings.draft_n` / `draft_n_accepted`). */
  draftTokens?: number;
  draftAccepted?: number;
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** Absent if the provider doesn't report usage (shouldn't happen for Anthropic/local, but keep it optional rather than fabricate zeros). */
  usage?: Usage;
  /** Extended-thinking replay data, Anthropic-only (see `Message`'s matching fields for why these
   * exist and why they must round-trip unmodified). `AgentLoop` stores these on the `think`
   * `ContextEntry` it creates for this turn, purely as opaque pass-through data - it never reads
   * or interprets them itself. */
  thinkingSignature?: string;
  redactedThinking?: string;
  /**
   * A tool call the output limit cut off mid-arguments, which the provider had to drop because
   * its JSON never finished. Without this the loop only sees a cut-off reply and asks the model to
   * continue its text, so the model never learns its `write_file` was not run - and on the tmp4
   * long run (2026-11-01) it tried to write a whole parser in one call. Set only alongside
   * `stopReason: 'max_tokens'`.
   */
  truncatedToolCall?: { name: string; argumentChars: number };
}

export interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * A local model server that cannot answer right now: not reachable at all (powered off, still booting, wrong
 * network), or reachable but still loading its model (`loading`). Not a failure of the request itself, so the
 * app waits for the server instead of just printing an error, and puts the user's message back in the input
 * box. `prompt` is filled in by AgentLoop after it rolls the interrupted turn back.
 */
export class ServerUnavailableError extends Error {
  prompt?: string;
  constructor(
    message: string,
    public readonly loading: boolean,
  ) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}
