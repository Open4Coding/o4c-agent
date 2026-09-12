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
