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

/**
 * Queries the server's own `/v1/models` for the id of whatever it actually has loaded - the
 * `-m`/`--model` CLI value means nothing to `LocalProvider.complete()` (it never sends a `model`
 * field at all, since llama-server only ever has one model loaded and doesn't need one), so
 * without this, the status bar/`/context` display would show a meaningless default model name
 * (e.g. the CLI's hardcoded Anthropic default) instead of what's actually being talked to.
 * Best-effort: returns undefined on any failure (server down, non-OpenAI-compatible response,
 * timeout) so a display-only lookup never blocks startup or crashes it.
 */
export async function fetchLocalModelId(baseUrl: string, apiKey?: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return data.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  private baseUrl: string;
  private timeoutMs: number;
  // Optional: most self-hosted llama-server instances don't require one (unlike Anthropic's,
  // which is mandatory - see AnthropicProvider). Only sent as a header when actually set, so a
  // server running without --api-key is unaffected either way. Env-var fallback only, no CLI
  // flag - matches ANTHROPIC_API_KEY's own convention, and keeps the key out of process.argv
  // (visible to anything that can list processes on the machine) and out of the args rebuilt by
  // cli.ts's spawnRestart for /clear, /resume - those already inherit the parent's full
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
          stream: true,
          // Without this, a streaming response omits usage entirely (the standard OpenAI-API
          // convention llama-server also implements - confirmed directly against its source,
          // `tools/server/server-schema.cpp`'s `stream_options.include_usage` field) - losing
          // token-usage reporting would be a real regression from the non-streaming behavior this
          // replaces, not an acceptable side effect of adding streaming.
          stream_options: { include_usage: true },
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

    if (!response.body) {
      throw new Error('Local server returned no response body to stream from.');
    }
    const { content, toolCalls, finishReason, usage } = await parseSseStream(response.body, request.onToken);

    return {
      content,
      toolCalls,
      stopReason: mapStopReason(finishReason),
      usage,
    };
  }
}

interface StreamedOpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // llama-server's own reasoning-model extension (`reasoning_format: "deepseek"`, confirmed
      // directly against a real streamed response from this project's own PHOEBE server) - this
      // model's `<think>...</think>` reasoning arrives through this separate field entirely, not
      // inline in `content` the way `splitThinkBlock()` (contextEntry.ts) expects. Real bug found
      // via direct user report ("thinking seems to stop"): every reasoning token was silently
      // dropped before this field was read at all, which for a model that reasons at length
      // before its first real content/tool call meant long stretches of genuine work produced
      // zero visible output - indistinguishable from a hang.
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface ParsedStream {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number } | undefined;
}

/**
 * Parses an OpenAI-compatible `text/event-stream` body (`data: {...}\n\n` lines, terminated by
 * `data: [DONE]`) - llama-server's own streaming format. Tool calls arrive incrementally too,
 * each fragment keyed by `index`; `id`/`function.name` typically only appear on that index's
 * first fragment, and `function.arguments` arrives as string pieces to concatenate and parse only
 * once the stream ends (a partial JSON fragment mid-stream isn't valid JSON on its own).
 */
export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onToken?: (delta: string) => void,
): Promise<ParsedStream> {
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage: ParsedStream['usage'];
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep a possibly-incomplete last line for the next read

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') continue;

        let chunk: StreamedOpenAIChunk;
        try {
          chunk = JSON.parse(payload) as StreamedOpenAIChunk;
        } catch {
          continue; // a malformed chunk shouldn't take down an otherwise-good stream
        }

        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.reasoning_content) {
          reasoning += choice.delta.reasoning_content;
          onToken?.(choice.delta.reasoning_content);
        }
        if (choice.delta?.content) {
          content += choice.delta.content;
          onToken?.(choice.delta.content);
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          const existing = toolCallsByIndex.get(call.index) ?? { id: '', name: '', args: '' };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) existing.args += call.function.arguments;
          toolCallsByIndex.set(call.index, existing);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({ id: call.id, name: call.name, input: JSON.parse(call.args || '{}') as Record<string, unknown> }));

  // Reassembled into the same `<think>...</think>` convention `splitThinkBlock()` already expects
  // from every other provider - the rest of the pipeline (AgentLoop, ContextEntry) needs no
  // changes to handle a model whose reasoning arrives via this separate API field instead of
  // inline tags in `content`.
  return { content: reasoning ? `<think>${reasoning}</think>${content}` : content, toolCalls, finishReason, usage };
}
