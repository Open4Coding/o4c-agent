import type { LLMProvider, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}

export interface RunOptions {
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
  images?: string[];
}

/** Thrown when the loop exhausts its iteration budget without the model reaching a final answer. */
export class MaxIterationsError extends Error {
  constructor(public readonly maxIterations: number) {
    super(`stopped after ${maxIterations} iterations without a final answer`);
    this.name = 'MaxIterationsError';
  }
}

export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  /** Number of completion requests actually sent to the provider, not turns or tool calls. */
  requestCount: number;
}

export class AgentLoop {
  private messages: Message[] = [];
  private usage: CumulativeUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };

  constructor(
    private provider: LLMProvider,
    private tools: Tool[],
    private systemPrompt: string,
  ) {}

  /** Clears conversation history and cumulative usage, starting a fresh session on the next `run()`. */
  reset(): void {
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  /** Raw conversation history so far - every message, tool call, and tool result. For debug/inspection UIs. */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** Token usage accumulated across every provider request this session, as reported by the provider - not estimated (except MockProvider, which has no real tokenizer to ask). */
  getUsage(): Readonly<CumulativeUsage> {
    return this.usage;
  }

  /**
   * Replaces in-memory history with a previously-saved session's messages (for /resume).
   * Cumulative usage resets to zero - it tracks this process's own request activity, not a
   * lifetime total for the session, so there's nothing real to restore it to.
   */
  loadMessages(messages: readonly Message[]): void {
    this.messages = [...messages];
    this.usage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  async run(userMessage: string, options: RunOptions = {}): Promise<string> {
    const maxIterations = options.maxIterations ?? 25;
    const onEvent = options.onEvent ?? (() => {});
    const messages = this.messages;
    messages.push({ role: 'user', content: userMessage, images: options.images });
    const toolDefs = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.provider.complete({
        systemPrompt: this.systemPrompt,
        messages,
        tools: toolDefs,
      });

      this.usage.requestCount += 1;
      if (response.usage) {
        this.usage.inputTokens += response.usage.inputTokens;
        this.usage.outputTokens += response.usage.outputTokens;
      }

      if (response.content) {
        onEvent({ type: 'text', text: response.content });
      }

      const isToolUse = response.stopReason === 'tool_use' && response.toolCalls.length > 0;
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: isToolUse ? response.toolCalls : undefined,
      });

      if (!isToolUse) {
        return response.content;
      }

      for (const call of response.toolCalls) {
        onEvent({ type: 'tool_call', toolName: call.name, toolInput: call.input });
        const tool = this.tools.find((t) => t.name === call.name);
        const output = tool
          ? await tool.execute(call.input)
          : `Error: no tool registered with name "${call.name}"`;
        onEvent({ type: 'tool_result', toolName: call.name, toolOutput: output });
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }
    }

    throw new MaxIterationsError(maxIterations);
  }
}
