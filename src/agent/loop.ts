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

export class AgentLoop {
  private messages: Message[] = [];

  constructor(
    private provider: LLMProvider,
    private tools: Tool[],
    private systemPrompt: string,
  ) {}

  /** Clears conversation history, starting a fresh session on the next `run()`. */
  reset(): void {
    this.messages = [];
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

    return '(stopped: max iterations reached without a final answer)';
  }
}
