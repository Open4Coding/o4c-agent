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
  /** Lets the caller cancel an in-flight request (e.g. the user pressed Escape while the
   * "Thinking..." spinner was showing). Providers that make a real network call should pass it
   * straight through to that call's own cancellation mechanism. */
  signal?: AbortSignal;
  /** Called with each raw text chunk as it streams in, if the provider supports streaming (both
   * real providers do). Purely a live-preview signal - undifferentiated (no `<think>` vs response
   * split, which needs the complete text to detect reliably) and not a replacement for the
   * final `CompletionResponse.content` this call still resolves to once the stream ends. Optional
   * so a caller that doesn't care about live preview (or MockProvider in tests) can just ignore
   * it - every provider must still fully resolve `complete()` normally either way. */
  onToken?: (delta: string) => void;
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
}

export interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
