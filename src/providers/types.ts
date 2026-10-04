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
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

/** Token counts for one completion request, as reported by the provider itself - not estimated. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
