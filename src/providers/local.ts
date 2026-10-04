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
import { ServerUnavailableError } from './types.js';

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

// A single flat timeout covering the whole request (5 min, then 20 min) was the wrong shape
// either way: real generation on a large (100K+) context can legitimately run long even at a
// healthy ~80 tokens/sec, so any fixed wall-clock cap either kills a healthy turn or - once
// raised far enough to stop doing that - stops meaningfully catching a real hang at all. Split
// into two different questions instead, matching what's actually being waited on at each point:
//
// - "did the server ever start responding" (DEFAULT_CONNECT_TIMEOUT_MS) - covers fetch() up to
//   the response headers. Stays generous: PHOEBE only serves one request at a time
//   (--parallel 1), so time-to-first-byte legitimately includes queuing behind whatever another
//   tool (Hermes, opencode) is already generating, not just this project's own load.
// - "is the model still producing output, right now" (DEFAULT_IDLE_TIMEOUT_MS) - covers the gap
//   between successive stream chunks once streaming has actually started (withIdleTimeout,
//   below). Resets on every chunk, so an actively-streaming response never trips it no matter how
//   long the total turn runs - only real silence (a crashed/deadlocked server mid-response) does.
//   Short by comparison, since continuous token output shouldn't go quiet for minutes at a time.
//
// Both configurable via config.json's connectTimeoutMs/idleTimeoutMs (cli.ts), same "no CLI flag"
// shape as contextWindow/localApiKey - these are the fallbacks when unset. Either can also be set
// to 0 or negative to disable that phase's timeout entirely (see complete()'s own comments) -
// distinct from "unset," which still falls back to the default here, not to "no timeout."
const DEFAULT_CONNECT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
// Only used when contextWindow isn't configured (no maxTokens override reaches the constructor) -
// matches the flat cap this replaced, so an unconfigured setup behaves exactly as before.
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Queries the server's own `/v1/models` for the id of whatever it actually has loaded - the
 * `-m`/`--model` CLI value means nothing to `LocalProvider.complete()` (it never sends a `model`
 * field at all, since llama-server only ever has one model loaded and doesn't need one), so
 * without this, the status bar/`/context` display would show a meaningless default model name
 * (e.g. the CLI's hardcoded Anthropic default) instead of what's actually being talked to.
 * Best-effort: returns undefined on any failure (server down, non-OpenAI-compatible response,
 * timeout) so a display-only lookup never blocks startup or crashes it.
 */
export type ServerStatus = 'up' | 'loading' | 'down';

export interface ServerProbe {
  status: ServerStatus;
  /** The served model's id, when the server is up and says so. */
  model?: string;
  /** The server's real context size (`/props` n_ctx - per slot, which is what one conversation gets). */
  contextWindow?: number;
}

/**
 * Asks the local server how it is doing, in one place: `down` (nothing answered - powered off, still booting,
 * wrong address), `loading` (it answered but is still loading the model: llama-server replies 503), or `up`
 * with the model id and context size. Any other HTTP answer, even a 404 from a server without `/props`, counts
 * as up - only a failure to connect or a silent timeout is `down`. Never throws.
 */
export async function probeLocalServer(baseUrl: string, apiKey?: string): Promise<ServerProbe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/props`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { status: 'down' };
  }
  if (response.status === 503) return { status: 'loading' };
  let contextWindow: number | undefined;
  if (response.ok) {
    try {
      const data = (await response.json()) as { default_generation_settings?: { n_ctx?: number } };
      const nCtx = data.default_generation_settings?.n_ctx;
      if (typeof nCtx === 'number' && nCtx > 0) contextWindow = nCtx;
    } catch {
      // an unparseable /props just means no context size; the server itself is up
    }
  }
  return { status: 'up', model: await fetchLocalModelId(baseUrl, apiKey), contextWindow };
}

/** True for the error fetch() raises when it could not reach the server at all (connection refused, host or
 * network unreachable, DNS failure) - as opposed to a timeout or a deliberate abort. */
function isUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { cause?: { code?: string } }).cause?.code ?? '';
  return err instanceof TypeError || ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code);
}

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

/**
 * Queries the server's own `/props` for the real context window it's actually running with
 * (`default_generation_settings.n_ctx`) - confirmed directly against a live PHOEBE server, not
 * assumed from docs (`curl .../props` returned `229376` here, matching what had previously only
 * been a hand-entered `contextWindow` in config.json). Without this, a user who never manually
 * sets that config key gets no context-window display or compaction trigger at all - the exact
 * gap behind a real silent-hang incident (a large-codebase search grew past the model's usable
 * context with no warning). Best-effort, same shape as `fetchLocalModelId`: undefined on any
 * failure (server down, older llama-server without this field, timeout) so a display-only lookup
 * never blocks startup or crashes it. A manually-configured `contextWindow` in config.json still
 * takes precedence over this when both are present - this is the fallback, not an override.
 */
export async function fetchLocalContextWindow(baseUrl: string, apiKey?: string): Promise<number | undefined> {
  try {
    const response = await fetch(`${baseUrl}/props`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { default_generation_settings?: { n_ctx?: number } };
    const nCtx = data.default_generation_settings?.n_ctx;
    return typeof nCtx === 'number' && nCtx > 0 ? nCtx : undefined;
  } catch {
    return undefined;
  }
}

export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  private baseUrl: string;
  private connectTimeoutMs: number;
  private idleTimeoutMs: number;
  // Optional: most self-hosted llama-server instances don't require one (unlike Anthropic's,
  // which is mandatory - see AnthropicProvider). Only sent as a header when actually set, so a
  // server running without --api-key is unaffected either way. Env-var fallback only, no CLI
  // flag - matches ANTHROPIC_API_KEY's own convention, and keeps the key out of process.argv
  // (visible to anything that can list processes on the machine) and out of the args rebuilt by
  // cli.ts's spawnRestart for /clear, /resume - those already inherit the parent's full
  // environment, so the env var survives a restart for free without needing to be threaded
  // through as an explicit arg.
  private apiKey: string | undefined;
  // Per-request output cap - was a flat 4096 regardless of the model's real context size, which
  // silently truncated any turn whose <think> reasoning alone ran past it (real bug, found via
  // direct reproduction against PHOEBE: the turn just ended with an empty answer, no error, no
  // work done). Set from config.json's own contextWindow (cli.ts), not guessed here.
  private maxTokens: number;

  constructor(
    options: {
      baseUrl?: string;
      connectTimeoutMs?: number;
      idleTimeoutMs?: number;
      apiKey?: string;
      maxTokens?: number;
    } = {},
  ) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:8080';
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.apiKey = options.apiKey ?? process.env.O4C_LOCAL_API_KEY;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /** Lets the app raise or lower the reply limit once it learns the real context size - e.g. when the server
   * was down at launch and its size was unknown until it came back. */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Own controller, not just AbortSignal.timeout() directly - its timer is explicitly cleared
    // the moment fetch() resolves (success or failure), below, so it can only ever fire while
    // still waiting for a response to start. Left un-cleared, the same fixed-deadline signal
    // would stay attached to the response body too (that's how fetch's signal works for its whole
    // lifecycle) and abort an actively-streaming turn just for having run past this deadline in
    // total - exactly the flat-timeout behavior this split replaces. Combined with the caller's
    // own signal so the user can still cancel early on demand (e.g. Escape while "Thinking..." is
    // showing) - covers cancellation for the whole request, not just this connect phase.
    //
    // 0 or negative means "no timeout at all" - `connectController` (and its timer) are simply
    // never created, so fetch() only ever aborts via request.signal, never on its own. An
    // explicit opt-out, not a huge-number workaround, for whoever would genuinely rather wait
    // forever than risk a false-positive abort.
    const connectController = this.connectTimeoutMs > 0 ? new AbortController() : undefined;
    const connectTimer = connectController
      ? setTimeout(
          () =>
            connectController.abort(
              Object.assign(
                new Error(
                  `Local server did not respond within ${Math.round(this.connectTimeoutMs / 1000)}s - it may be busy with another request, or the model may be stuck generating. Try again, or check the local server.`,
                ),
                { name: 'TimeoutError' },
              ),
            ),
          this.connectTimeoutMs,
        )
      : undefined;
    const connectSignal = connectController
      ? request.signal
        ? AbortSignal.any([connectController.signal, request.signal])
        : connectController.signal
      : request.signal;

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
          // Per-request override preferred when given - see CompletionRequest.maxTokens's own
          // doc comment for the exact mid-generation truncation bug this closes.
          max_tokens: request.maxTokens ?? this.maxTokens,
          stream: true,
          // Without this, a streaming response omits usage entirely (the standard OpenAI-API
          // convention llama-server also implements - confirmed directly against its source,
          // `tools/server/server-schema.cpp`'s `stream_options.include_usage` field) - losing
          // token-usage reporting would be a real regression from the non-streaming behavior this
          // replaces, not an acceptable side effect of adding streaming.
          stream_options: { include_usage: true },
        }),
        signal: connectSignal,
      });
    } catch (err) {
      // The server could not be reached at all: say so with a type the app acts on (it waits for the server and
      // puts the message back), rather than a bare "fetch failed". A deliberate cancel or the connect timeout
      // (the server answered the connection but not the request) keep their own handling.
      if (request.signal?.aborted || !isUnreachable(err)) throw err;
      throw new ServerUnavailableError(`The local server at ${this.baseUrl} is not reachable.`, false);
    } finally {
      // Whether fetch resolved, rejected, or was aborted - either way this timer must never fire
      // again after this point (see connectController's own comment for why). A TimeoutError
      // rejection here already carries the friendly message set at abort time, nothing to catch.
      if (connectTimer) clearTimeout(connectTimer);
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          this.apiKey
            ? `Local server rejected the API key (401) - it may have changed or been rotated on the server.`
            : `Local server requires an API key (401) - set the O4C_LOCAL_API_KEY environment variable.`,
        );
      }
      const body = await response.text();
      if (response.status === 503 && /loading/i.test(body)) {
        throw new ServerUnavailableError('The local server is still loading the model.', true);
      }
      throw new Error(`Local server error (status ${response.status}): ${body}`);
    }

    if (!response.body) {
      throw new Error('Local server returned no response body to stream from.');
    }

    // Real generation happens here, not in the fetch() above - a big turn on a large context can
    // spend most of its time in this stream, not in getting a response header back. Guarded by
    // idle time (withIdleTimeout), not total duration - see the DEFAULT_*_TIMEOUT_MS comment for
    // why - and still cancellable via request.signal directly (unrelated to connectController,
    // which is already neutralized by the clearTimeout above by the time execution reaches here).
    // Real bug, found via direct user report: a 25-minute local-model turn surfaced "Unexpected
    // error: The operation was aborted due to timeout" instead of a friendly message - this call
    // used to sit outside any try/catch entirely, so a timeout landing here (mid-stream, not at
    // connect) reached the caller as a raw, unhandled error instead of withIdleTimeout's own
    // already-friendly one.
    //
    // 0 or negative disables this the same way as connectTimeoutMs above - the raw body is passed
    // straight through, unwrapped, so there's no timer left running to ever fire at all.
    const idleBody = this.idleTimeoutMs > 0 ? withIdleTimeout(response.body, this.idleTimeoutMs) : response.body;
    const { content, toolCalls, finishReason, usage } = await parseSseStream(idleBody, request.onToken);
    return {
      content,
      toolCalls,
      stopReason: mapStopReason(finishReason),
      usage,
    };
  }
}

/**
 * Wraps a response body stream so a gap of `idleMs` between successive chunks - not the stream's
 * total duration - is what counts as "stuck." Resets on every chunk read, so an actively
 * streaming response never trips it no matter how long the turn runs in total; only the server
 * actually going quiet (crashed or deadlocked mid-response) does. The underlying reader is
 * cancelled when that happens, so the stalled connection doesn't linger after this gives up on it.
 */
function withIdleTimeout(body: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Definite-assignment: the Promise executor below runs synchronously (per spec), so this is
      // always set before it's read - TS's control-flow analysis just can't see through `new
      // Promise()` to know that.
      let timer!: ReturnType<typeof setTimeout>;
      let timedOut = false;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            Object.assign(
              new Error(
                `Local server produced no output for ${Math.round(idleMs / 1000)}s - the model may be stuck generating. Try again, or check the local server.`,
              ),
              { name: 'TimeoutError' },
            ),
          );
        }, idleMs);
      });
      try {
        const result = await Promise.race([reader.read(), idle]);
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (err) {
        if (timedOut) void reader.cancel(err).catch(() => {});
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
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
  onToken?: (delta: string, kind: 'think' | 'text') => void,
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
          onToken?.(choice.delta.reasoning_content, 'think');
        }
        if (choice.delta?.content) {
          content += choice.delta.content;
          onToken?.(choice.delta.content, 'text');
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

  // Real bug found via direct reproduction (2026-10-03, a --parallel 1 run at only 16% context
  // use): a tool call whose arguments got cut off mid-JSON by the max_tokens cap - e.g. a
  // write_file with a large `content` - used to throw straight out of here ("Unterminated string
  // in JSON at position 27918"), surfacing as a raw "Unexpected error" that killed the whole turn.
  // A truncated tool call is a NORMAL consequence of hitting the output cap, not a crash: drop the
  // unparseable call and let the caller's existing max_tokens handling (loop.ts auto-continues on
  // a `max_tokens` stopReason) retry the round, exactly as it would for any other cut-off response.
  const toolCalls: ToolCall[] = [];
  for (const [, call] of [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b)) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(call.args || '{}') as Record<string, unknown>;
    } catch {
      continue; // truncated/malformed arguments - see above
    }
    toolCalls.push({ id: call.id, name: call.name, input });
  }

  // Reassembled into the same `<think>...</think>` convention `splitThinkBlock()` already expects
  // from every other provider - the rest of the pipeline (AgentLoop, ContextEntry) needs no
  // changes to handle a model whose reasoning arrives via this separate API field instead of
  // inline tags in `content`.
  return { content: reasoning ? `<think>${reasoning}</think>${content}` : content, toolCalls, finishReason, usage };
}
