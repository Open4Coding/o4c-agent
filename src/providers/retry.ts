import type { CompletionRequest, CompletionResponse, LLMProvider } from './types.js';
import { ServerUnavailableError } from './types.js';

/**
 * Provider retry with backoff, and an optional fallback chain (plan 0006 F1).
 *
 * Retried: HTTP 429 and 5xx, and timeouts - the failures that are about the moment, not the
 * request. Not retried: anything after text has started streaming (a retry would print the start
 * of the answer twice; the loop's own continuation logic owns that case), a cancelled request,
 * 4xx other than 429 (the request itself is wrong; sending it again cannot help), and the server
 * being down or loading - `ServerUnavailableError` already has its own wait-and-resend flow.
 *
 * When one provider's retries are spent on a retryable failure, the next provider in the chain gets
 * the same request (config `fallbackChain`, built by `createProvider`). A non-retryable failure is
 * the request's fault and is thrown straight away, never handed to a fallback.
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ServerUnavailableError) return false;
  const name = (err as { name?: unknown } | undefined)?.name;
  if (name === 'AbortError' || name === 'AbortedError') return false;
  if (name === 'TimeoutError' || name === 'APIConnectionTimeoutError' || name === 'APIConnectionError') return true;
  const status = statusOf(err);
  return status !== undefined && (status === 429 || status >= 500);
}

export interface RetryOptions {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** First wait in ms, doubled each time (default 1000), with up to 25% jitter. */
  baseDelayMs?: number;
  /** Longest single wait, Retry-After included (default 30 s). */
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Told about each retry and fallback, for the run log and the screen. */
  onRetry?: (info: { provider: string; attempt: number; delayMs: number; error: string; fallback?: string }) => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Wraps `chain[0]` (with `chain[1..]` as fallbacks) in retry-with-backoff. */
export class RetryingProvider implements LLMProvider {
  readonly name: string;
  countTokens?: LLMProvider['countTokens'];
  endReasoning?: LLMProvider['endReasoning'];

  constructor(
    private readonly chain: readonly LLMProvider[],
    private readonly options: RetryOptions = {},
  ) {
    if (chain.length === 0) throw new Error('RetryingProvider needs at least one provider.');
    const primary = chain[0]!;
    this.name = primary.name;
    if (primary.countTokens) this.countTokens = (r) => primary.countTokens!(r);
    if (primary.endReasoning) this.endReasoning = () => primary.endReasoning!();
  }

  /** The provider requests actually go to first - for callers that need its own methods. */
  get primary(): LLMProvider {
    return this.chain[0]!;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const retries = this.options.retries ?? 2;
    const base = this.options.baseDelayMs ?? 1000;
    const max = this.options.maxDelayMs ?? 30_000;
    const sleep = this.options.sleep ?? defaultSleep;
    const random = this.options.random ?? Math.random;
    let streamed = false;
    const guarded: CompletionRequest = request.onToken
      ? {
          ...request,
          onToken: (delta, kind) => {
            streamed = true;
            request.onToken!(delta, kind);
          },
        }
      : request;

    let lastError: unknown;
    for (let p = 0; p < this.chain.length; p++) {
      const provider = this.chain[p]!;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await provider.complete(guarded);
        } catch (err) {
          lastError = err;
          if (streamed || request.signal?.aborted || !isRetryable(err)) throw err;
          if (attempt === retries) break;
          const hinted = err instanceof ProviderHttpError ? err.retryAfterMs : undefined;
          const delayMs = Math.min(max, hinted ?? base * 2 ** attempt * (1 + random() * 0.25));
          this.options.onRetry?.({ provider: provider.name, attempt: attempt + 1, delayMs, error: err instanceof Error ? err.message : String(err) });
          await sleep(delayMs, request.signal);
        }
      }
      const next = this.chain[p + 1];
      if (next) {
        this.options.onRetry?.({
          provider: provider.name,
          attempt: retries + 1,
          delayMs: 0,
          error: lastError instanceof Error ? lastError.message : String(lastError),
          fallback: next.name,
        });
      }
    }
    throw lastError;
  }
}
