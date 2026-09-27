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

// Matches LocalProvider's own DEFAULT_TIMEOUT_MS exactly, for the same reason: an explicit,
// intentional bound in this codebase rather than an implicit one inherited from a dependency.
// The Anthropic SDK does already have its own real default (confirmed directly,
// `node_modules/@anthropic-ai/sdk/index.js`: `Anthropic.DEFAULT_TIMEOUT = 600000` / 10 minutes),
// so this was never actually unbounded - but 10 minutes of a frozen "Thinking..." with no
// user-facing explanation is a long time to wait before the one existing backstop (request.signal,
// only set when the user manually presses Escape/Ctrl+C) is the only other way out.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(options: { apiKey?: string; model?: string; timeoutMs?: number } = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment.',
      );
    }
    this.client = new Anthropic({ apiKey, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.model = options.model ?? 'claude-opus-5';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system: request.systemPrompt,
          messages: toAnthropicMessages(request.messages),
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        },
        { signal: request.signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        const timeoutMs = this.client.timeout;
        throw new Error(
          `Anthropic did not respond within ${Math.round(timeoutMs / 1000)}s - try again, or check anthropic.com's status page.`,
        );
      }
      throw err;
    }

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
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
