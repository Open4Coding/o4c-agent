import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalProvider, probeLocalServer } from '../providers/local.js';
import { ServerUnavailableError, type CompletionRequest, type CompletionResponse, type LLMProvider } from '../providers/types.js';
import { AgentLoop } from '../agent/loop.js';

type Handler = (url: string) => { status: number; body: string };

async function startServer(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? '/');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** A base URL nothing is listening on: bind a port, then close it. */
async function deadUrl(): Promise<string> {
  const { baseUrl, server } = await startServer(() => ({ status: 200, body: '{}' }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return baseUrl;
}

const REQUEST: CompletionRequest = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

test('probeLocalServer reports up with the model id and the real context size', async () => {
  const { baseUrl, server } = await startServer((url) =>
    url.startsWith('/props')
      ? { status: 200, body: JSON.stringify({ default_generation_settings: { n_ctx: 57344 } }) }
      : { status: 200, body: JSON.stringify({ data: [{ id: 'qwen-test' }] }) },
  );
  try {
    assert.deepEqual(await probeLocalServer(baseUrl), { status: 'up', model: 'qwen-test', contextWindow: 57344 });
  } finally {
    server.close();
  }
});

test('probeLocalServer reports loading when the server answers 503 (llama-server while it loads the model)', async () => {
  const { baseUrl, server } = await startServer(() => ({ status: 503, body: '{"error":{"message":"Loading model"}}' }));
  try {
    assert.deepEqual(await probeLocalServer(baseUrl), { status: 'loading' });
  } finally {
    server.close();
  }
});

test('probeLocalServer reports down when nothing is listening', async () => {
  assert.deepEqual(await probeLocalServer(await deadUrl()), { status: 'down' });
});

test('probeLocalServer treats any other HTTP answer (a server without /props) as up, just without a context size', async () => {
  const { baseUrl, server } = await startServer(() => ({ status: 404, body: 'not found' }));
  try {
    const probe = await probeLocalServer(baseUrl);
    assert.equal(probe.status, 'up');
    assert.equal(probe.contextWindow, undefined);
  } finally {
    server.close();
  }
});

test('LocalProvider throws ServerUnavailableError (not loading) when the server cannot be reached', async () => {
  const provider = new LocalProvider({ baseUrl: await deadUrl() });
  await assert.rejects(
    () => provider.complete(REQUEST),
    (err: unknown) => err instanceof ServerUnavailableError && err.loading === false,
  );
});

test('LocalProvider throws ServerUnavailableError (loading) on a 503 Loading model, and a plain error on any other 503', async () => {
  const loading = await startServer(() => ({ status: 503, body: '{"error":{"message":"Loading model"}}' }));
  const other = await startServer(() => ({ status: 503, body: 'overloaded' }));
  try {
    await assert.rejects(
      () => new LocalProvider({ baseUrl: loading.baseUrl }).complete(REQUEST),
      (err: unknown) => err instanceof ServerUnavailableError && err.loading === true,
    );
    await assert.rejects(
      () => new LocalProvider({ baseUrl: other.baseUrl }).complete(REQUEST),
      (err: unknown) => !(err instanceof ServerUnavailableError) && err instanceof Error && /503/.test(err.message),
    );
  } finally {
    loading.server.close();
    other.server.close();
  }
});

test('a deliberate cancel while the server is unreachable stays a cancel, not a server-down error', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new LocalProvider({ baseUrl: await deadUrl() });
  await assert.rejects(
    () => provider.complete({ ...REQUEST, signal: controller.signal }),
    (err: unknown) => !(err instanceof ServerUnavailableError),
  );
});

test('AgentLoop rolls the turn back and hands the message to the caller when the server is unavailable', async () => {
  const provider: LLMProvider = {
    name: 'down',
    async complete(_request: CompletionRequest): Promise<CompletionResponse> {
      throw new ServerUnavailableError('server is down', false);
    },
  };
  const loop = new AgentLoop(provider, [], 'system');
  await assert.rejects(
    () => loop.run('please do the thing', { onEvent: () => {} }),
    (err: unknown) => err instanceof ServerUnavailableError && err.prompt === 'please do the thing',
  );
  assert.deepEqual(loop.getEntries(), [], 'the history is exactly as before the turn, as if it was never sent');
});

test('setMaxTokens changes the limit sent with the next request', async () => {
  let seen: number | undefined;
  const { baseUrl, server } = await (async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = (JSON.parse(body) as { max_tokens?: number }).max_tokens;
        res.writeHead(500);
        res.end('stop here');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  })();
  try {
    const provider = new LocalProvider({ baseUrl, maxTokens: 100 });
    provider.setMaxTokens(2222);
    await provider.complete(REQUEST).catch(() => {});
    assert.equal(seen, 2222);
  } finally {
    server.close();
  }
});
