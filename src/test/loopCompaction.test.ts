import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../agent/loop.js';
import { userInputEntry, aiResponseEntry, type ContextEntry } from '../agent/contextEntry.js';
import { FakeProvider } from './fakeProvider.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';

// content.length 400 -> estimateTokens() (chars/4) = 100 tokens per entry, 200 per turn.
function padded(label: string): string {
  return `${label} ${'x'.repeat(396)}`.slice(0, 400);
}

/** `n` turns of user input + ai response, each ~200 estimated tokens. */
function buildOldTurns(n: number): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(userInputEntry(padded(`old user turn ${i}`)));
    entries.push(aiResponseEntry(padded(`old assistant turn ${i}`)));
  }
  return entries;
}

test('compaction triggers before the turn, hides old entries, keeps the recent tail, and adds a visible summary', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ user_intent: 'build the thing', next_step: 'ship it' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'new answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(8)); // 8 * 2 * TURN_TOKENS = 1600 estimated tokens

  const result = await loop.run('new message', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 }, // threshold = 1400 < 1600
  });

  assert.equal(result, 'new answer');
  assert.equal(provider.callCount, 2); // one compaction call, one real turn call

  const entries = loop.getEntries();
  const compactionEntries = entries.filter((e) => e.type === 'ai' && e.sub_type === 'compaction');
  assert.equal(compactionEntries.length, 1);
  assert.notEqual(compactionEntries[0].agent_visible, false); // the summary itself stays visible

  const hidden = entries.filter((e) => e.agent_visible === false);
  const stillVisibleOld = entries.filter(
    (e) => e.content.startsWith('old ') && e.agent_visible !== false,
  );
  assert.ok(hidden.length > 0, 'expected some old entries to be hidden');
  assert.ok(stillVisibleOld.length > 0, 'expected some recent old-turn entries to survive in the tail');
  assert.ok(hidden.length < buildOldTurns(8).length, 'not literally everything should be hidden');

  // Wire projection: hidden entries' content must not leak through, the summary must, and the
  // new turn's own exchange must still be there.
  const wire = loop.getMessages();
  const wireText = wire.map((m) => m.content).join('\n');
  assert.ok(!wireText.includes(hidden[0].content), "a hidden entry's raw content leaked into the wire projection");
  assert.ok(wireText.includes('build the thing'));
  assert.ok(wireText.includes('new message'));
});

test('compaction call itself gets no tools and a plain-JSON system prompt, separate from the real turn request', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ next_step: 'x' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system prompt text');
  loop.loadEntries(buildOldTurns(8));

  await loop.run('go', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  const [compactionRequest, realRequest] = provider.receivedRequests;
  assert.deepEqual(compactionRequest.tools, []);
  assert.equal(compactionRequest.messages.length, 1);
  assert.equal(compactionRequest.messages[0].role, 'user');
  assert.ok(compactionRequest.systemPrompt?.includes('JSON'));

  assert.equal(realRequest.systemPrompt, 'system prompt text');
});

test('a second compaction seeds itself from the first summary (iterative update, not regenerate)', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ next_step: 'first summary' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer 1', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(8));
  await loop.run('turn A', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  // Pile on enough fresh, large entries that the very next turn is over-threshold again.
  const more = buildOldTurns(6).map((e) => ({ ...e, content: padded(e.content) }));
  loop.loadEntries([...loop.getEntries(), ...more]);

  provider.enqueue(
    { content: JSON.stringify({ next_step: 'second summary' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer 2', toolCalls: [], stopReason: 'end_turn' },
  );

  await loop.run('turn B', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  const secondCompactionRequest = provider.receivedRequests[2];
  assert.ok(secondCompactionRequest.messages[0].content.includes('<previous-summary>'));
  assert.ok(secondCompactionRequest.messages[0].content.includes('first summary'));
});

test('compaction never fires when contextWindow is not provided - existing behavior unchanged', async () => {
  const provider = new FakeProvider([{ content: 'answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(8));

  await loop.run('go');

  assert.equal(provider.callCount, 1); // no compaction call
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
});

test('a failed compaction call is swallowed - the turn itself still proceeds normally', async () => {
  let calls = 0;
  const flaky: LLMProvider = {
    name: 'flaky',
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      calls++;
      if (calls === 1) throw new Error('summarizer is down');
      return { content: 'answer despite the failed compaction', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const loop = new AgentLoop(flaky, [], 'system');
  loop.loadEntries(buildOldTurns(8));

  const result = await loop.run('go', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  assert.equal(result, 'answer despite the failed compaction');
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
  assert.equal(loop.getEntries().some((e) => e.agent_visible === false), false); // nothing hidden
});
