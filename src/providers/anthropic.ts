import Anthropic from '@anthropic-ai/sdk';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
  StopReason,
  ToolCall,
} from './types.js';

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      result.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? '',
            content: msg.content,
          },
        ],
      });
    }
  }

  return result;
}

function mapStopReason(reason: string | null): StopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment.',
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = options.model ?? 'claude-sonnet-4-5';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: request.systemPrompt,
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      stopReason: mapStopReason(response.stop_reason),
    };
  }
}
