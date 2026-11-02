import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseSseStream, timingsToUsage } from '../providers/local.js';
import { addUsage, emptyUsage } from '../agent/loop.js';
import { UsageStore, USAGE_FILE_VERSION } from '../session/usageStore.js';
import { cacheReportLines, cacheSharePercent } from '../ui/statusBar.js';

/** Plan 0006 A1: llama-server's cache/prefill/MTP figures, from the wire to the footer. */

// The final two chunks of a real PHOEBE response (b10868, 2026-11-02), verbatim apart from the id.
const PHOEBE_TAIL = [
  'data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}],"created":1793606824,"id":"x","model":"qwen","object":"chat.completion.chunk"}',
  'data: {"choices":[],"created":1793606824,"id":"x","model":"qwen","object":"chat.completion.chunk","usage":{"completion_tokens":4,"prompt_tokens":18,"total_tokens":22,"prompt_tokens_details":{"cached_tokens":0}},"timings":{"cache_n":0,"prompt_n":18,"prompt_ms":372.554,"prompt_per_token_ms":20.697444444444443,"prompt_per_second":48.31514357650166,"predicted_n":4,"predicted_ms":171.827,"predicted_per_token_ms":57.275666666666666,"predicted_per_second":17.459421394774978,"draft_n":6,"draft_n_accepted":4}}',
  'data: [DONE]',
  '',
].join('\n\n');

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

test('a real final chunk yields every figure; cache_n + prompt_n equals prompt_tokens', async () => {
  const { usage } = await parseSseStream(stream(PHOEBE_TAIL));
  assert.deepEqual(usage, {
    inputTokens: 18,
    outputTokens: 4,
    tokensPerSecond: 17.459421394774978,
    cachedTokens: 0,
    processedPromptTokens: 18,
    prefillMs: 372.554,
    draftTokens: 6,
    draftAccepted: 4,
  });
  assert.equal(usage!.cachedTokens! + usage!.processedPromptTokens!, usage!.inputTokens);
});

test('absent fields stay undefined - nothing fabricated; usage-only cached_tokens is used as a fallback', () => {
  assert.deepEqual(timingsToUsage(undefined), {});
  assert.deepEqual(timingsToUsage({ predicted_per_second: 40 }), {});
  assert.deepEqual(timingsToUsage(undefined, 120), { cachedTokens: 120 });
});

test('addUsage sums the cache figures and keeps the last response', () => {
  const total = emptyUsage();
  addUsage(total, { inputTokens: 100, outputTokens: 5, cachedTokens: 90, processedPromptTokens: 10, prefillMs: 50, draftTokens: 6, draftAccepted: 5 });
  addUsage(total, { inputTokens: 110, outputTokens: 5 });
  addUsage(total, undefined);
  assert.equal(total.requestCount, 3);
  assert.equal(total.cachedTokens, 90);
  assert.equal(total.processedPromptTokens, 10);
  assert.equal(total.draftAccepted, 5);
  assert.equal(total.last?.inputTokens, 110);
});

test('usage file v4: the cache sums survive a reload; a v3 file reads them as 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-cache-usage-'));
  try {
    const file = join(dir, 'usage.json');
    await writeFile(file, JSON.stringify({ version: 3, project: { input: 5, output: 1 }, sessions: { s1: { input: 5, output: 1, requests: 1, activeMs: 10 } } }));
    const spend = { input: 100, output: 4, requests: 2, cached: 80, processed: 20, prefillMs: 300, draftN: 10, draftAccepted: 8 };
    const first = new UsageStore(file, () => spend);
    first.load('s1');
    assert.equal(first.totals().session.cached, 80, 'v3 baseline reads as 0, plus this process');
    first.flush();
    const second = new UsageStore(file, () => ({ ...spend, cached: 10, processed: 0, prefillMs: 0, draftN: 0, draftAccepted: 0 }));
    second.load('s1');
    const s = second.totals().session;
    assert.equal(s.cached, 90);
    assert.equal(s.processed, 20);
    assert.equal(s.draftAccepted, 8);
    assert.equal(USAGE_FILE_VERSION, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('footer share and /context lines', () => {
  assert.equal(cacheSharePercent(0, 0), undefined, 'no data: the footer leaves the field out');
  assert.equal(cacheSharePercent(97, 3), 97);
  assert.deepEqual(cacheReportLines({ cached: 0, processed: 0, prefillMs: 0, draftN: 0, draftAccepted: 0 }), []);
  const lines = cacheReportLines(
    { cached: 9000, processed: 1000, prefillMs: 4200, draftN: 10, draftAccepted: 7 },
    { cachedTokens: 900, processedPromptTokens: 100, prefillMs: 360 },
  );
  assert.deepEqual(lines, [
    '  Prompt cache:  90% of prompt tokens served from cache (9000 cached, 1000 processed)',
    '  Prefill time:  4.2 s this session',
    '  Last request:  900 cached, 100 processed in 0.4 s',
    '  MTP drafts:    70% accepted (7/10)',
  ]);
});
