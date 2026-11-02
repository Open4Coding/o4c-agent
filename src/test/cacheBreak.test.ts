import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeCacheBreak, diagnoseCacheBreak, firstDivergence } from '../agent/cacheBreak.js';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../providers/types.js';

/** Plan 0006 A2: naming the cause of a prompt-cache miss. */

const user = (content: string): Message => ({ role: 'user', content });
const ai = (content: string): Message => ({ role: 'assistant', content });
const req = (messages: Message[], systemPrompt = 'sys', tools: CompletionRequest['tools'] = []): CompletionRequest => ({ systemPrompt, messages, tools });

test('firstDivergence: appended history is not a divergence; a rewritten earlier message is', () => {
  const prev = [user('a'), ai('b'), user('c')];
  assert.equal(firstDivergence(prev, [user('a'), ai('b'), user('c'), ai('d'), user('e')]), -1);
  assert.equal(firstDivergence(prev, [user('a'), ai('b'), user('c, edited at the tail')]), -1, 'the last message may change');
  assert.equal(firstDivergence(prev, [user('a'), ai('B'), user('c'), ai('d')]), 1);
  assert.equal(firstDivergence(prev, [user('a')]), 1, 'history cut short');
});

test('diagnoseCacheBreak: held cache, system prompt, tools, history, evicted', () => {
  const prev = req([user('a'), ai('b'), user('c')]);
  const next = req([user('a'), ai('b'), user('c'), ai('d'), user('e')]);
  assert.equal(diagnoseCacheBreak(prev, 1000, next, { inputTokens: 1100, outputTokens: 5, cachedTokens: 995 }), undefined);
  assert.equal(diagnoseCacheBreak(undefined, 1000, next, { inputTokens: 1100, outputTokens: 5, cachedTokens: 0 }), undefined, 'first request');
  assert.equal(diagnoseCacheBreak(prev, 1000, next, { inputTokens: 1100, outputTokens: 5 }), undefined, 'server did not say');

  const miss = { inputTokens: 1100, outputTokens: 5, cachedTokens: 0 };
  assert.equal(diagnoseCacheBreak(prev, 1000, { ...next, systemPrompt: 'sys\n\nPlan mode' }, miss)?.reason, 'system prompt');
  assert.equal(diagnoseCacheBreak(prev, 1000, { ...next, tools: [{ name: 'x', description: 'd', inputSchema: {} }] }, miss)?.reason, 'tools');
  const hist = diagnoseCacheBreak(prev, 1000, req([user('a'), ai('B'), user('c'), ai('d')]), miss);
  assert.deepEqual(hist, { reason: 'history', at: 1, expected: 1000, cached: 0 });
  assert.equal(diagnoseCacheBreak(prev, 1000, next, miss)?.reason, 'evicted');
  assert.equal(describeCacheBreak(hist!), 'cache break: history (message 1) - reused 0 of 1000 prompt tokens');
});

/** Answers every call with a tool-free reply; reports a full cache hit unless the system prompt changed. */
class CacheAwareProvider implements LLMProvider {
  readonly name = 'cache-aware';
  private lastSystem: string | undefined;
  private lastInput = 0;
  /** Simulates another client taking the slot. */
  forgetCache(): void {
    this.lastInput = 0;
  }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const input = 100 + request.messages.length * 10;
    const cachedTokens = this.lastSystem === undefined || this.lastSystem === request.systemPrompt ? this.lastInput : 0;
    this.lastSystem = request.systemPrompt;
    this.lastInput = input;
    return { content: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: input, outputTokens: 2, cachedTokens, processedPromptTokens: input - cachedTokens } };
  }
}

test('a mode switch no longer breaks the cache (A5); a miss on a pure append is reported as evicted, with an event', async () => {
  const provider = new CacheAwareProvider();
  const loop = new AgentLoop(provider, [], 'system');
  const events: AgentEvent[] = [];
  const onEvent = (e: AgentEvent) => events.push(e);
  await loop.run('one', { onEvent });
  await loop.run('two', { onEvent, modeInstruction: 'Current mode: Plan.' });
  await loop.run('three', { onEvent, modeInstruction: 'Current mode: Auto.' });
  assert.equal(loop.getCacheBreaks().length, 0, 'mode switches: the system prompt never changed');
  provider.forgetCache();
  await loop.run('four', { onEvent });
  const breaks = loop.getCacheBreaks();
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.reason, 'evicted');
  assert.match(events.find((e) => e.type === 'cache_break')!.text!, /^cache break: evicted/);
});
