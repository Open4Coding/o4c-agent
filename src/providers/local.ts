import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
  StopReason,
  ToolCall,
} from './types.js';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function toImageDataUri(path: string): Promise<string> {
  const mime = MIME_TYPES[extname(path).toLowerCase()] ?? 'image/png';
  const data = await readFile(path);
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function toOpenAIMessages(
  systemPrompt: string | undefined,
  messages: Message[],
): Promise<OpenAIMessage[]> {
  const result: OpenAIMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (msg.images && msg.images.length > 0) {
        const parts: ContentPart[] = [{ type: 'text', text: msg.content }];
        for (const path of msg.images) {
          parts.push({ type: 'image_url', image_url: { url: await toImageDataUri(path) } });
        }
        result.push({ role: 'user', content: parts });
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      const toolCalls = (msg.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      }));
      result.push({
        role: 'assistant',
        content: msg.content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === 'tool') {
      result.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolCallId ?? '' });
    }
  }

  return result;
}

function mapStopReason(reason: string): StopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  private baseUrl: string;

  constructor(options: { baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:8080';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: await toOpenAIMessages(request.systemPrompt, request.messages),
        tools: request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local server error (status ${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { content: string | null; tool_calls?: OpenAIToolCall[] };
      }>;
    };

    const choice = data.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: choice.message.content ?? '',
      toolCalls,
      stopReason: mapStopReason(choice.finish_reason),
    };
  }
}
