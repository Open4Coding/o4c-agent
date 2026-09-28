import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider } from '../providers/local.js';
import type { CompletionRequest } from '../providers/types.js';

const baseRequest: CompletionRequest = {
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

function okResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'hi back' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// fetch is a global, so tests replace and restore it around each call rather than mocking the
// module - LocalProvider calls the bare `fetch(...)`, nothing module-scoped to inject instead.
async function withMockedFetch<T>(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = init;
    return handler(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    // Stash the last captured init on the function object so callers that only care about
    // headers don't need their own closure variable - see capturedHeaders() below.
    (withMockedFetch as unknown as { lastCaptured?: RequestInit }).lastCaptured = captured;
  }
}

function capturedHeaders(): Record<string, string> {
  const init = (withMockedFetch as unknown as { lastCaptured?: RequestInit }).lastCaptured;
  return (init?.headers as Record<string, string>) ?? {};
}

test('sends no Authorization header when no API key is configured', async () => {
  const provider = new LocalProvider({});
  await withMockedFetch(() => okResponse(), () => provider.complete(baseRequest));
  assert.equal('Authorization' in capturedHeaders(), false);
});

test('sends an Authorization: Bearer header when apiKey is passed explicitly', async () => {
  const provider = new LocalProvider({ apiKey: 'test-key-123' });
  await withMockedFetch(() => okResponse(), () => provider.complete(baseRequest));
  assert.equal(capturedHeaders().Authorization, 'Bearer test-key-123');
});

test('falls back to O4C_LOCAL_API_KEY when no explicit apiKey option is given', async () => {
  const original = process.env.O4C_LOCAL_API_KEY;
  process.env.O4C_LOCAL_API_KEY = 'from-env-456';
  try {
    const provider = new LocalProvider({});
    await withMockedFetch(() => okResponse(), () => provider.complete(baseRequest));
    assert.equal(capturedHeaders().Authorization, 'Bearer from-env-456');
  } finally {
    if (original === undefined) delete process.env.O4C_LOCAL_API_KEY;
    else process.env.O4C_LOCAL_API_KEY = original;
  }
});

test('an explicit apiKey option overrides the environment variable', async () => {
  const original = process.env.O4C_LOCAL_API_KEY;
  process.env.O4C_LOCAL_API_KEY = 'from-env-should-be-overridden';
  try {
    const provider = new LocalProvider({ apiKey: 'explicit-wins' });
    await withMockedFetch(() => okResponse(), () => provider.complete(baseRequest));
    assert.equal(capturedHeaders().Authorization, 'Bearer explicit-wins');
  } finally {
    if (original === undefined) delete process.env.O4C_LOCAL_API_KEY;
    else process.env.O4C_LOCAL_API_KEY = original;
  }
});

test('a 401 with no API key configured gives an actionable error naming O4C_LOCAL_API_KEY', async () => {
  const provider = new LocalProvider({});
  await assert.rejects(
    withMockedFetch(
      () => new Response('unauthorized', { status: 401 }),
      () => provider.complete(baseRequest),
    ),
    /O4C_LOCAL_API_KEY/,
  );
});

test('an idle gap mid-stream (not just a slow connect) aborts with its own friendly message', async () => {
  // Regression test for a real bug found live: a single flat timeout covering the whole request
  // meant real generation (which happens while parseSseStream reads the response body, well after
  // fetch() itself resolves) could get killed - or, once that call moved outside any try/catch
  // entirely to "fix" it, surface a raw unhandled error - just for legitimately running long. The
  // replacement (withIdleTimeout) only reacts to silence between chunks, so a stream that starts
  // fine but then never produces a second chunk is exactly what should trip it.
  function neverStreamsResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {}); // never resolves - simulates a stalled connection
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  const provider = new LocalProvider({ idleTimeoutMs: 30 });
  await assert.rejects(
    withMockedFetch(neverStreamsResponse, () => provider.complete(baseRequest)),
    (err: Error) => {
      assert.match(err.message, /produced no output for/);
      assert.doesNotMatch(err.message, /Unexpected error|aborted due to timeout|did not respond within/);
      return true;
    },
  );
});

test('a connect-phase timeout (server never even responds) gives the "busy" message, not a generic one', async () => {
  // Different phase, different wording: this is the OTHER half of the split - a server that never
  // starts responding at all (e.g. queued behind another tool's request against the same PHOEBE
  // instance, which only serves one at a time) should read as "busy," not "stuck generating."
  // withMockedFetch's handler always returns a Response synchronously, so this one replaces
  // globalThis.fetch directly with something that only ever settles via the abort signal.
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;
  try {
    const provider = new LocalProvider({ connectTimeoutMs: 30 });
    await assert.rejects(provider.complete(baseRequest), (err: Error) => {
      assert.match(err.message, /did not respond within/);
      assert.match(err.message, /busy with another request/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('idleTimeoutMs of 0 or negative disables the idle timeout entirely', async () => {
  // Not just "large enough to not matter" - genuinely disabled. Proven by using a real gap (40ms)
  // that a positive idle timeout smaller than it (this same shape passes with idleTimeoutMs: 30
  // in the earlier test, aborting well before 40ms) would have tripped on.
  function slowThenDoneResponse(): Response {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        sent = true;
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'),
        );
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  for (const idleTimeoutMs of [0, -1]) {
    const provider = new LocalProvider({ idleTimeoutMs });
    const result = await withMockedFetch(slowThenDoneResponse, () => provider.complete(baseRequest));
    assert.equal(result.stopReason, 'end_turn');
  }
});

test('connectTimeoutMs of 0 or negative disables the connect timeout entirely', async () => {
  // Same proof shape as the idle test above: a real 40ms delay before fetch() resolves, which a
  // positive connect timeout smaller than it (30ms passes in the earlier "busy" test, aborting
  // well before 40ms) would have tripped on.
  for (const connectTimeoutMs of [0, -1]) {
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(okResponse()), 40);
      })) as typeof fetch;
    try {
      const provider = new LocalProvider({ connectTimeoutMs });
      const result = await provider.complete(baseRequest);
      assert.ok(result);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('a 401 with an API key already configured suggests it may be wrong, not "set" it', async () => {
  const provider = new LocalProvider({ apiKey: 'stale-key' });
  await assert.rejects(
    withMockedFetch(
      () => new Response('unauthorized', { status: 401 }),
      () => provider.complete(baseRequest),
    ),
    (err: Error) => {
      assert.match(err.message, /rejected the API key/);
      assert.doesNotMatch(err.message, /O4C_LOCAL_API_KEY/);
      return true;
    },
  );
});
