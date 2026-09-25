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

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  private baseUrl: string;
  private timeoutMs: number;
  // Optional: most self-hosted llama-server instances don't require one (unlike Anthropic's,
  // which is mandatory - see AnthropicProvider). Only sent as a header when actually set, so a
  // server running without --api-key is unaffected either way. Env-var fallback only, no CLI
  // flag - matches ANTHROPIC_API_KEY's own convention, and keeps the key out of process.argv
  // (visible to anything that can list processes on the machine) and out of the args rebuilt by
  // cli.ts's spawnRestart for /clear, /wipe, /resume - those already inherit the parent's full
  // environment, so the env var survives a restart for free without needing to be threaded
  // through as an explicit arg.
  private apiKey: string | undefined;

  constructor(options: { baseUrl?: string; timeoutMs?: number; apiKey?: string } = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:8080';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiKey = options.apiKey ?? process.env.O4C_LOCAL_API_KEY;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          messages: await toOpenAIMessages(request.systemPrompt, request.messages),
          tools: request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          max_tokens: 4096,
        }),
        // Without a timeout signal, a hung or runaway generation (e.g. a model stuck repeating
        // inside a <think> block) leaves the request in flight forever - nothing in AgentLoop or
        // the UI can cancel it, so the whole REPL (including /exit, queued behind the turn) is
        // effectively frozen until this resolves on its own. Combined with the caller's own
        // signal (if given) so the user can also cancel early on demand (e.g. Escape while the
        // "Thinking..." spinner is showing), without losing the timeout as a backstop.
        signal: request.signal
          ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), request.signal])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `Local server did not respond within ${Math.round(this.timeoutMs / 1000)}s - the model may be stuck generating. Try again, or check the local server.`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          this.apiKey
            ? `Local server rejected the API key (401) - it may have changed or been rotated on the server.`
            : `Local server requires an API key (401) - set the O4C_LOCAL_API_KEY environment variable.`,
        );
      }
      throw new Error(`Local server error (status ${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { content: string | null; tool_calls?: OpenAIToolCall[] };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
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
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  }
}
