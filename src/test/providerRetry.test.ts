import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, parseRetryAfter, ProviderHttpError, RetryingProvider } from '../providers/retry.js';
import { createProvider, parseProviderSpecs } from '../providers/factory.js';
import { ServerUnavailableError, type CompletionRequest, type CompletionResponse, type LLMProvider } from '../providers/types.js';

const OK = { text: 'ok' } as unknown as CompletionResponse;
const REQ = { systemPrompt: '', messages: [] } as unknown as CompletionRequest;

function scripted(name: string, outcomes: (Error | 'ok' | 'stream-then-fail')[]): LLMProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const o = outcomes[Math.min(p.calls, outcomes.length - 1)]!;
      p.calls++;
      if (o === 'ok') return OK;
      if (o === 'stream-then-fail') {
        req.onToken?.('Hel', 'text');
        throw new ProviderHttpError('dropped', 502);
      }
      throw o;
    },
  };
  return p;
}

const noSleep = { sleep: async () => {}, random: () => 0 };

test('isRetryable: 429, 5xx and timeouts yes; 4xx, aborts and a down server no', () => {
  assert.equal(isRetryable(new ProviderHttpError('x', 429)), true);
  assert.equal(isRetryable(new ProviderHttpError('x', 503)), true);
  assert.equal(isRetryable(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
  assert.equal(isRetryable(Object.assign(new Error('sdk'), { status: 529 })), true, 'an SDK error with a status');
  assert.equal(isRetryable(new ProviderHttpError('x', 400)), false);
  assert.equal(isRetryable(Object.assign(new Error('a'), { name: 'AbortError' })), false);
  assert.equal(isRetryable(new ServerUnavailableError('down', false)), false);
  assert.equal(isRetryable(new Error('plain')), false);
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:58 GMT')), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
});

test('retries a 503 with doubling backoff, then succeeds', async () => {
  const p = scripted('local', [new ProviderHttpError('busy', 503), new ProviderHttpError('busy', 503), 'ok']);
  const waits: number[] = [];
  const r = new RetryingProvider([p], { sleep: async (ms) => void waits.push(ms), random: () => 0, baseDelayMs: 100 });
  assert.equal(await r.complete(REQ), OK);
  assert.equal(p.calls, 3);
  assert.deepEqual(waits, [100, 200]);
});

test('Retry-After wins over the backoff, capped at maxDelayMs', async () => {
  const p = scripted('local', [new ProviderHttpError('slow down', 429, 90_000), 'ok']);
  const waits: number[] = [];
  const r = new RetryingProvider([p], { sleep: async (ms) => void waits.push(ms), maxDelayMs: 5000 });
  await r.complete(REQ);
  assert.deepEqual(waits, [5000]);
});

test('no retry once text has streamed, nor for a bad request', async () => {
  const streaming = scripted('local', ['stream-then-fail', 'ok']);
  const shown: string[] = [];
  await assert.rejects(new RetryingProvider([streaming], noSleep).complete({ ...REQ, onToken: (d) => void shown.push(d) }), /dropped/);
  assert.equal(streaming.calls, 1);
  assert.deepEqual(shown, ['Hel'], 'the caller still saw what streamed');
  const bad = scripted('local', [new ProviderHttpError('bad request', 400), 'ok']);
  await assert.rejects(new RetryingProvider([bad], noSleep).complete(REQ), /bad request/);
  assert.equal(bad.calls, 1);
});

test('a cancelled request stops retrying', async () => {
  const p = scripted('local', [new ProviderHttpError('busy', 503), 'ok']);
  const ac = new AbortController();
  const r = new RetryingProvider([p], {
    sleep: async () => {
      ac.abort();
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    },
  });
  await assert.rejects(r.complete({ ...REQ, signal: ac.signal }), /Aborted/);
  assert.equal(p.calls, 1);
});

test('when retries run out, the fallback chain gets the request; a bad request never falls back', async () => {
  const primary = scripted('local', [new ProviderHttpError('down', 502)]);
  const backup = scripted('anthropic', ['ok']);
  const events: string[] = [];
  const r = new RetryingProvider([primary, backup], { ...noSleep, retries: 1, onRetry: (i) => void events.push(i.fallback ? `fallback->${i.fallback}` : `retry ${i.attempt}`) });
  assert.equal(r.name, 'local');
  assert.equal(await r.complete(REQ), OK);
  assert.equal(primary.calls, 2);
  assert.equal(backup.calls, 1);
  assert.deepEqual(events, ['retry 1', 'fallback->anthropic']);
  const bad = scripted('local', [new ProviderHttpError('bad', 400)]);
  const unused = scripted('anthropic', ['ok']);
  await assert.rejects(new RetryingProvider([bad, unused], noSleep).complete(REQ), /bad/);
  assert.equal(unused.calls, 0);
});

test('the wrapper forwards countTokens and endReasoning to the primary', async () => {
  const p = { name: 'local', complete: async () => OK, countTokens: async () => 42, endReasoning: async () => true };
  const r = new RetryingProvider([p]);
  assert.equal(await r.countTokens!(REQ), 42);
  assert.equal(await r.endReasoning!(), true);
  assert.equal(new RetryingProvider([{ name: 'm', complete: async () => OK }]).countTokens, undefined);
});

test('parseProviderSpecs validates fallbackChain entries by index; createProvider builds them', () => {
  const { specs, errors } = parseProviderSpecs([{ provider: 'local', baseUrl: 'http://x:8080', apiKeyEnv: 'MY_KEY' }, { provider: 'local' }, { provider: 'gpt' }, { provider: 'mock' }]);
  assert.equal(specs.length, 2);
  assert.deepEqual(errors, ['fallbackChain[1]: a local fallback needs "baseUrl".', 'fallbackChain[2]: "provider" must be "local" or "anthropic".']);
  assert.match(parseProviderSpecs({}).errors[0]!, /must be a list/);
  assert.equal(createProvider(specs[0]!, {}, { MY_KEY: 'k' }).name, 'local');
  assert.equal(createProvider({ provider: 'mock' }).name.length > 0, true);
});
