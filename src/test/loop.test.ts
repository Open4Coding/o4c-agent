import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, AbortedError, MaxIterationsError } from '../agent/loop.js';
import { aiResponseEntry, estimateTokens, userInputEntry } from '../agent/contextEntry.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';

test('returns immediately when the model ends the turn with no tool calls', async () => {
  const provider = new FakeProvider([
    { content: 'the answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const result = await loop.run('hello');

  assert.equal(result, 'the answer');
  assert.equal(provider.callCount, 1);
});

test('onProviderCall fires once per real provider round-trip with the exact request and response', async () => {
  const tool = makeFakeTool('read_file', 'file contents here');
  const provider = new FakeProvider([
    {
      content: 'let me check',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'foo.txt' } }],
      stopReason: 'tool_use',
    },
    { content: 'the file says: file contents here', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');
  const calls: Array<{ request: unknown; response: unknown }> = [];

  await loop.run('what does foo.txt say?', { onProviderCall: (call) => calls.push(call) });

  assert.equal(calls.length, 2);
  assert.equal((calls[0].response as { content: string }).content, 'let me check');
  assert.equal((calls[1].response as { content: string }).content, 'the file says: file contents here');
  // The exact request actually sent, not a re-derived approximation - same messages FakeProvider
  // itself recorded.
  assert.deepEqual(
    (calls[1].request as { messages: unknown[] }).messages,
    provider.receivedRequests[1].messages,
  );
});

test('onProviderCall is never called for a failed/aborted request', async () => {
  const provider: LLMProvider = {
    name: 'always-fails',
    complete: async () => {
      throw new Error('boom');
    },
  };
  const loop = new AgentLoop(provider, [], 'system');
  const calls: unknown[] = [];

  await assert.rejects(() => loop.run('hello', { onProviderCall: (call) => calls.push(call) }));

  assert.equal(calls.length, 0);
});

test('executes a tool call, feeds the result back, and returns the final answer', async () => {
  const tool = makeFakeTool('read_file', 'file contents here');
  const provider = new FakeProvider([
    {
      content: 'let me check',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'foo.txt' } }],
      stopReason: 'tool_use',
    },
    { content: 'the file says: file contents here', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const result = await loop.run('what does foo.txt say?');

  assert.equal(result, 'the file says: file contents here');
  assert.equal(provider.callCount, 2);
  assert.deepEqual(tool.calls, [{ path: 'foo.txt' }]);
});

test('handles multiple tool calls in a single turn', async () => {
  const toolA = makeFakeTool('tool_a', 'result A');
  const toolB = makeFakeTool('tool_b', 'result B');
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [
        { id: 't1', name: 'tool_a', input: {} },
        { id: 't2', name: 'tool_b', input: {} },
      ],
      stopReason: 'tool_use',
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [toolA, toolB], 'system');

  const result = await loop.run('do both things');

  assert.equal(result, 'done');
  assert.equal(toolA.calls.length, 1);
  assert.equal(toolB.calls.length, 1);
});

test('feeds back an error message when the model calls an unregistered tool, instead of crashing', async () => {
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'nonexistent_tool', input: {} }],
      stopReason: 'tool_use',
    },
    { content: 'recovered', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const result = await loop.run('call a tool that does not exist');

  assert.equal(result, 'recovered');
});

test('stops after maxIterations if the model never ends the turn', async () => {
  const tool = makeFakeTool('loop_tool', 'ok');
  const infiniteResponses = Array.from({ length: 10 }, () => ({
    content: '',
    toolCalls: [{ id: 't', name: 'loop_tool', input: {} }],
    stopReason: 'tool_use' as const,
  }));
  const provider = new FakeProvider(infiniteResponses);
  const loop = new AgentLoop(provider, [tool], 'system');

  await assert.rejects(
    () => loop.run('never stop', { maxIterations: 3 }),
    MaxIterationsError,
  );
  assert.equal(provider.callCount, 3);
});

test('maxIterations of 0 or negative removes the cap entirely, not just raises it', async () => {
  // Regression test for a real bug found via direct user report: a long autonomous turn against a
  // local model hit the default 25-iteration cap well before it was actually done. Proves this
  // isn't just "a generous default" - 30 tool-call rounds (past the old default of 25) followed
  // by a real final answer must complete successfully, for both 0 and a negative value.
  const tool = makeFakeTool('loop_tool', 'ok');
  for (const maxIterations of [0, -1]) {
    const toolRounds = Array.from({ length: 30 }, () => ({
      content: '',
      toolCalls: [{ id: 't', name: 'loop_tool', input: {} }],
      stopReason: 'tool_use' as const,
    }));
    const provider = new FakeProvider([
      ...toolRounds,
      { content: 'done', toolCalls: [], stopReason: 'end_turn' as const },
    ]);
    const loop = new AgentLoop(provider, [tool], 'system');

    const result = await loop.run('do a lot of work', { maxIterations });

    assert.equal(result, 'done');
    assert.equal(provider.callCount, 31);
  }
});

test('retains conversation history across multiple run() calls', async () => {
  const provider = new FakeProvider([
    { content: 'first answer', toolCalls: [], stopReason: 'end_turn' },
    { content: 'second answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  await loop.run('first question');
  await loop.run('second question');

  const secondRequestMessages = provider.receivedRequests[1].messages;
  assert.deepEqual(
    secondRequestMessages.map((m) => m.content),
    ['first question', 'first answer', 'second question'],
  );
});

test('reset() clears history so the next run() starts fresh', async () => {
  const provider = new FakeProvider([
    { content: 'first answer', toolCalls: [], stopReason: 'end_turn' },
    { content: 'second answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  await loop.run('first question');
  loop.reset();
  await loop.run('second question');

  const secondRequestMessages = provider.receivedRequests[1].messages;
  assert.deepEqual(secondRequestMessages.map((m) => m.content), ['second question']);
});

test('toolPolicy denying a call skips execution and feeds back a blocked message', async () => {
  const tool = makeFakeTool('write_file', 'should never see this', true);
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'x' } }],
      stopReason: 'tool_use',
    },
    { content: 'ok', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  await loop.run('write something', { toolPolicy: async () => 'deny' });

  assert.equal(tool.calls.length, 0);
  const toolMessage = provider.receivedRequests[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage?.content ?? '', /Blocked by the current mode/);
});

test('an abort signaled from within toolPolicy (e.g. Escape on a confirm dialog) stops the whole turn before the next provider round, not just that one call', async () => {
  // Real bug found via hands-on testing, 2026-09-26: Escape on a tool confirmation dialog wasn't
  // wired to the AbortSignal at all, so declining one call this way let the model immediately try
  // another - "hitting Esc here just lets every other next window open." Proactive checks
  // (checkAborted(), loop.ts) fix this by not relying on the provider itself to notice the abort.
  const tool = makeFakeTool('write_file', 'should never run', true);
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'x' } }],
      stopReason: 'tool_use',
    },
    { content: 'should never be reached', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');
  const controller = new AbortController();

  await assert.rejects(
    () =>
      loop.run('write something', {
        signal: controller.signal,
        toolPolicy: async () => {
          controller.abort(); // simulates Escape firing on this call's confirm dialog
          return 'deny';
        },
      }),
    AbortedError,
  );

  assert.equal(provider.callCount, 1); // the second provider round never happened
  assert.equal(tool.calls.length, 0);
  assert.deepEqual(loop.getEntries(), []); // rolled back completely, as any abort does
});

test('toolPolicy allowing a call runs the tool normally', async () => {
  const tool = makeFakeTool('write_file', 'wrote it', true);
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'x' } }],
      stopReason: 'tool_use',
    },
    { content: 'ok', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  await loop.run('write something', { toolPolicy: async () => 'allow' });

  assert.equal(tool.calls.length, 1);
});

test('modeInstruction is appended to the system prompt sent to the provider, per request', async () => {
  const provider = new FakeProvider([{ content: 'ok', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'base system prompt');

  await loop.run('hello', { modeInstruction: 'Current mode: Plan. Do not write or run shell.' });

  assert.equal(
    provider.receivedRequests[0].systemPrompt,
    'base system prompt\n\nCurrent mode: Plan. Do not write or run shell.',
  );
});

test('omitting modeInstruction sends the system prompt unchanged, as before', async () => {
  const provider = new FakeProvider([{ content: 'ok', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'base system prompt');

  await loop.run('hello');

  assert.equal(provider.receivedRequests[0].systemPrompt, 'base system prompt');
});

test('omitting toolPolicy runs every tool call unconditionally, as before', async () => {
  const tool = makeFakeTool('write_file', 'wrote it', true);
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'x' } }],
      stopReason: 'tool_use',
    },
    { content: 'ok', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  await loop.run('write something');

  assert.equal(tool.calls.length, 1);
});

test('aborting the signal mid-turn rolls back history and throws AbortedError carrying the original prompt', async () => {
  // Simulates what a real provider does when its own in-flight request is cancelled: the abort
  // happens first (as it would from the UI's Escape handler racing the request), then the
  // provider's own call rejects (however that specific provider spells it - loop.ts deliberately
  // doesn't pattern-match the error, only `options.signal.aborted`, precisely so it doesn't need
  // to care).
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'fake',
    async complete() {
      controller.abort();
      throw new Error('simulated in-flight cancellation');
    },
  };
  const loop = new AgentLoop(provider, [], 'system');

  await assert.rejects(
    () => loop.run('the prompt that got cancelled', { signal: controller.signal }),
    (err: unknown) => err instanceof AbortedError && err.prompt === 'the prompt that got cancelled',
  );
  assert.deepEqual(loop.getMessages(), []);
});

test('an aborted turn does not disturb an earlier, already-completed turn in history', async () => {
  let callCount = 0;
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'fake',
    async complete() {
      callCount += 1;
      if (callCount === 1) {
        return { content: 'first answer', toolCalls: [], stopReason: 'end_turn' };
      }
      controller.abort();
      throw new Error('simulated in-flight cancellation');
    },
  };
  const loop = new AgentLoop(provider, [], 'system');

  await loop.run('first question');
  await assert.rejects(() => loop.run('second question', { signal: controller.signal }), AbortedError);

  assert.deepEqual(
    loop.getMessages().map((m) => m.content),
    ['first question', 'first answer'],
  );
});

test('emits events for text, tool_call, and tool_result in order', async () => {
  const tool = makeFakeTool('read_file', 'contents');
  const provider = new FakeProvider([
    {
      content: 'checking',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'x' } }],
      stopReason: 'tool_use',
    },
    { content: 'final', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  // 'delta' (the raw streamed-text preview, one per provider call - see loop.ts's onToken wiring)
  // is filtered out here since it's not what this test is about; covered on its own below.
  const events: string[] = [];
  await loop.run('go', { onEvent: (e) => e.type !== 'delta' && events.push(e.type) });

  assert.deepEqual(events, ['text', 'tool_call', 'tool_result', 'text']);
});

test('a response cut off by max_tokens emits a "warning" event, instead of silently returning nothing', async () => {
  // Real bug this replaces: a provider reporting stopReason 'max_tokens' (the response got cut
  // off, often mid-<think>) used to fall through the exact same path as a normal finish - no
  // indication anything was truncated, sometimes an entirely empty final answer. A second,
  // normal response is queued because the loop now also retries a max_tokens cutoff (see the
  // "auto-continues" test below) - this test is only about the warning still firing on that
  // first, cut-off round.
  const provider = new FakeProvider([
    { content: '<think>still reasoning, never finished', toolCalls: [], stopReason: 'max_tokens' },
    { content: 'picking back up - all done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  await loop.run('go', { onEvent: (e) => events.push({ type: e.type, text: e.text }) });

  const warning = events.find((e) => e.type === 'warning');
  assert.ok(warning, 'expected a "warning" event when stopReason is max_tokens');
  assert.match(warning?.text ?? '', /max_tokens/);
});

test('a max_tokens cutoff with no tool call retries instead of ending the turn, and only warns on the cut-off round', async () => {
  // Real bug found via direct reproduction (2026-10-02, a --parallel 4 stress test): a model can
  // burn its entire max_tokens budget on one verbose <think> block before ever reaching a tool
  // call or a real answer - this used to end the turn right there, stranding the user with
  // nothing done. The loop should instead retry (same as a tool_use continuation) until the
  // model actually finishes.
  const provider = new FakeProvider([
    { content: '<think>still reasoning, never finished', toolCalls: [], stopReason: 'max_tokens' },
    { content: 'continuing the thought and now finishing up', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', { onEvent: (e) => events.push({ type: e.type, text: e.text }) });

  assert.equal(provider.callCount, 2, 'expected a retry call after the max_tokens cutoff');
  assert.equal(result, 'continuing the thought and now finishing up');
  assert.equal(events.filter((e) => e.type === 'warning').length, 1, 'only the cut-off round should warn');
});

test('a model that never converges past max_tokens still stops at maxIterations, not forever', async () => {
  const neverFinishes = Array.from({ length: 5 }, () => ({
    content: '<think>still going',
    toolCalls: [],
    stopReason: 'max_tokens' as const,
  }));
  const provider = new FakeProvider(neverFinishes);
  const loop = new AgentLoop(provider, [], 'system');

  await assert.rejects(
    () => loop.run('go', { maxIterations: 5 }),
    (err: Error) => err.name === 'MaxIterationsError' || /iterations/.test(err.message),
  );
  assert.equal(provider.callCount, 5);
});

test('a second consecutive max_tokens cutoff hides the first round\'s entries - the regression this fix introduced and then closed', async () => {
  // Real bug found via direct reproduction (2026-10-02): the auto-continue fix above let an
  // unbroken chain of max_tokens cutoffs grow unchecked (no tool-call pair for MicroCompact, no
  // new user message for a real compaction cut) until a real run hit the server's hard context
  // limit outright (exceed_context_size_error, 86016 tokens against a 57344 n_ctx server). Each
  // new cutoff round should hide the previous one's now-superseded entries.
  const provider = new FakeProvider([
    { content: '<think>round one, cut off', toolCalls: [], stopReason: 'max_tokens' },
    { content: '<think>round two, cut off', toolCalls: [], stopReason: 'max_tokens' },
    { content: 'round three, finally done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', { onEvent: (e) => events.push({ type: e.type, text: e.text }) });

  assert.equal(provider.callCount, 3);
  assert.equal(result, 'round three, finally done');
  const prunes = events.filter((e) => e.type === 'prune');
  assert.equal(prunes.length, 1, 'exactly one prune: round 2 superseding round 1 (round 3 ends the turn, nothing supersedes it)');
  assert.match(prunes[0].text ?? '', /superseded max_tokens-cutoff entr(y|ies)/);
});

test('a max_tokens cutoff superseded by a TOOL CALL (not another cutoff) still gets hidden - the second real bug found live', async () => {
  // Real bug found via direct reproduction (2026-10-02): the first fix above only hid a cutoff's
  // entries when ANOTHER cutoff followed - but a real run showed a tool call can follow a cutoff
  // instead. That tool call cleared the chain's tracking without hiding anything, so the original
  // giant cutoff think block sat as permanent dead weight until ordinary growth pushed the whole
  // turn past the server's hard context limit outright (exceed_context_size_error, 63622 tokens
  // against a 57344 n_ctx server). Moving past a cutoff must hide it regardless of what comes next.
  const tool = makeFakeTool('read_file', 'file contents');
  const provider = new FakeProvider([
    { content: '<think>cut off before any tool call', toolCalls: [], stopReason: 'max_tokens' },
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'read_file', input: {} }],
      stopReason: 'tool_use',
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', { onEvent: (e) => events.push({ type: e.type, text: e.text }) });

  assert.equal(result, 'done');
  const prunes = events.filter((e) => e.type === 'prune');
  assert.equal(prunes.length, 1, 'the cutoff round should be hidden once the tool-call round supersedes it');
  assert.match(prunes[0].text ?? '', /superseded max_tokens-cutoff entr(y|ies)/);
});

test('a normal end_turn finish never emits a "warning" event', async () => {
  const provider = new FakeProvider([{ content: 'all done', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: string[] = [];
  await loop.run('go', { onEvent: (e) => events.push(e.type) });

  assert.ok(!events.includes('warning'));
});

test('streams a "delta" event per provider call, ahead of that call\'s own "text"/"think" events', async () => {
  const provider = new FakeProvider([
    { content: 'checking', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'x' } }], stopReason: 'tool_use' },
    { content: 'final', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [makeFakeTool('read_file', 'contents')], 'system');

  const events: string[] = [];
  await loop.run('go', { onEvent: (e) => events.push(e.type) });

  assert.deepEqual(events, ['delta', 'text', 'tool_call', 'tool_result', 'delta', 'text']);
});

test('a "delta" event\'s kind reflects what the provider actually reported for that chunk (think vs. text)', async () => {
  // FakeProvider always reports 'text' (it has no equivalent to a real provider's structured
  // think/text split) - this exercises loop.ts's own passthrough of a provider that reports
  // both kinds for one response, the real shape LocalProvider/AnthropicProvider send.
  const provider: LLMProvider = {
    name: 'kind-aware-test',
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      request.onToken?.('reasoning first', 'think');
      request.onToken?.('the real answer', 'text');
      return { content: 'the real answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const loop = new AgentLoop(provider, [], 'system');

  const deltas: Array<{ text?: string; kind?: 'think' | 'text' }> = [];
  await loop.run('go', {
    onEvent: (e) => {
      if (e.type === 'delta') deltas.push({ text: e.text, kind: e.kind });
    },
  });

  assert.deepEqual(deltas, [
    { text: 'reasoning first', kind: 'think' },
    { text: 'the real answer', kind: 'text' },
  ]);
});

test('a <think> block is split out: emitted as its own "think" event, and stripped from the final answer', async () => {
  const provider = new FakeProvider([
    { content: '<think>2+2 is basic addition</think>The answer is 4.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('what is 2+2?', {
    onEvent: (e) => e.type !== 'delta' && events.push({ type: e.type, text: e.text }),
  });

  assert.equal(result, 'The answer is 4.');
  assert.deepEqual(events, [
    { type: 'think', text: '2+2 is basic addition' },
    { type: 'text', text: 'The answer is 4.' },
  ]);
  assert.deepEqual(
    loop.getEntries().map((e) => ({ type: e.type, sub_type: e.sub_type, content: e.content })),
    [
      { type: 'user', sub_type: 'input', content: 'what is 2+2?' },
      { type: 'ai', sub_type: 'think', content: '2+2 is basic addition' },
      { type: 'ai', sub_type: 'response', content: 'The answer is 4.' },
    ],
  );
});

test('no <think> tag at all: no "think" event fires, behavior is unchanged from before', async () => {
  const provider = new FakeProvider([{ content: 'plain answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: string[] = [];
  const result = await loop.run('hi', { onEvent: (e) => e.type !== 'delta' && events.push(e.type) });

  assert.equal(result, 'plain answer');
  assert.deepEqual(events, ['text']);
});

test('getVisibleTokenEstimate() grows as entries are appended and returns to 0 after reset()', async () => {
  const provider = new FakeProvider([{ content: 'the answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  assert.equal(loop.getVisibleTokenEstimate(), 0);
  await loop.run('hello');
  assert.ok(loop.getVisibleTokenEstimate() > 0);

  loop.reset();
  assert.equal(loop.getVisibleTokenEstimate(), 0);
});

test('getVisibleTokenEstimate() is rolled back along with history when a turn aborts mid-flight', async () => {
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'fake',
    async complete() {
      controller.abort();
      throw new Error('simulated in-flight cancellation');
    },
  };
  const loop = new AgentLoop(provider, [], 'system');

  await assert.rejects(() => loop.run('this gets cancelled', { signal: controller.signal }), AbortedError);

  // The user-input entry was appended (and indexed) before the provider call, then rolled back -
  // the running token estimate must not still be counting it.
  assert.equal(loop.getVisibleTokenEstimate(), 0);
});

test('loadEntries() re-derives getVisibleTokenEstimate() from the loaded entries, not zero', async () => {
  const provider = new FakeProvider([{ content: 'first answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  await loop.run('first question');
  const savedEntries = loop.getEntries();
  const expected = loop.getVisibleTokenEstimate();

  const restored = new AgentLoop(provider, [], 'system');
  restored.loadEntries(savedEntries);

  assert.equal(restored.getVisibleTokenEstimate(), expected);
});

test('loadEntries() excludes agent_visible=false entries from getVisibleTokenEstimate()', () => {
  const provider = new FakeProvider([]);
  const loop = new AgentLoop(provider, [], 'system');

  const kept = userInputEntry('kept');
  const summarizedAway = { ...aiResponseEntry('a long-ago response now folded into a summary'), agent_visible: false };
  loop.loadEntries([kept, summarizedAway]);

  assert.equal(loop.getVisibleTokenEstimate(), estimateTokens(kept));
});

test('request.maxTokens shrinks to the real remaining budget as the prompt grows, instead of staying a flat half-window value', async () => {
  // Real bug found via direct reproduction (2026-10-03): max_tokens used to be a single static
  // value (half the context window, set once at provider construction) for every request
  // regardless of prompt size - confirmed live, a single response ran 9+ minutes generating
  // 16,289 tokens straight before the server cut it off at its hard n_ctx (truncated: 1), not a
  // clean stop from us. The naive static value here would be floor(10000/2) = 5000 on every call;
  // this proves the actual value sent shrinks as history grows instead.
  const provider = new FakeProvider([
    { content: 'first', toolCalls: [], stopReason: 'end_turn' },
    { content: 'second', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  // ~5000 estimated tokens of prior history - large enough that the real remaining budget
  // (contextWindow - prompt - safety margin) drops below the naive static half-window value
  // (5000) the old code would have used regardless of prompt size.
  const bigEntry = aiResponseEntry('x'.repeat(20000));
  loop.loadEntries([bigEntry]);

  await loop.run('go', { contextWindow: 10000 });

  const sent = provider.receivedRequests[0].maxTokens;
  assert.ok(sent !== undefined, 'expected a computed maxTokens override, not the provider default (undefined here)');
  assert.ok(sent! < 5000, `expected less than the naive static half-window value (5000), got ${sent}`);
  assert.ok(sent! > 0, 'expected a positive budget, not zero or negative');
});

test('a single response is never allowed even a quarter of the window, however small the prompt is', async () => {
  // THE root cause of the 2026-10-03 runaway rounds, proven from a real run's provider-call log
  // (tmp.tmp3): with a small prompt the old per-response ceiling (half the window) applied, the
  // model was allowed 28,672 output tokens and used 28,300 of them on one planning block - taking
  // context from 21K to 49K in a single round, after which every later round is starved and no
  // amount of compaction recovers. A single response must never be able to eat the window like
  // that, no matter how much room technically exists at send time.
  const provider = new FakeProvider([{ content: 'done', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  // Deliberately near-empty history: this is the exact case where the ceiling (not the remaining
  // budget) is what binds, which is what made the old half-window value so damaging.
  await loop.run('go', { contextWindow: 57344 });

  const sent = provider.receivedRequests[0].maxTokens;
  assert.ok(sent !== undefined, 'expected a computed maxTokens override');
  assert.ok(
    sent! <= Math.floor(57344 / 4),
    `one response must never be allocated more than a quarter of the window, got ${sent}`,
  );
  assert.ok(
    sent! < Math.floor(57344 / 2),
    'must be well under the old half-window value that caused the runaway',
  );
});

test('an empty end-of-turn reply after real tool work is retried once with a nudge, not silently ended', async () => {
  // Real bug (2026-10-03): the model emitted EOS after a single token following a prune, and the
  // turn ended silently with nothing done. An empty completion that isn't a cutoff or a tool call
  // is retried once, visibly, before the turn is allowed to end.
  const tool = makeFakeTool('write_file', 'ok');
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 't1', name: 'write_file', input: {} }], stopReason: 'tool_use' },
    { content: '', toolCalls: [], stopReason: 'end_turn' },
    { content: 'finished for real', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', { onEvent: (e) => events.push({ type: e.type, text: e.text }) });

  assert.equal(result, 'finished for real', 'the empty reply should be retried, not returned as the answer');
  assert.equal(provider.callCount, 3);
  assert.ok(
    events.some((e) => e.type === 'warning' && /empty reply/.test(e.text ?? '')),
    'the retry must be visible to the user, not silent',
  );
});

test('a reply ending mid-sentence after real tool work is retried once, not silently ended (2026-10-04)', async () => {
  // Real bug: the model returned "...Now" (17 tokens, end_turn) after a long tool-heavy turn, and
  // the turn ended there with nothing done. Same failure as an empty reply, so it gets one nudge.
  const tool = makeFakeTool('write_file', 'ok');
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 't1', name: 'write_file', input: {} }], stopReason: 'tool_use' },
    { content: 'Now', toolCalls: [], stopReason: 'end_turn' },
    { content: 'all files written', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', { onEvent: (e) => events.push({ type: e.type, text: e.text }) });

  assert.equal(result, 'all files written');
  assert.equal(provider.callCount, 3);
  assert.ok(events.some((e) => e.type === 'warning' && /mid-reply/.test(e.text ?? '')));
});

test('a short plain answer with no tool work still ends the turn normally (no false retry)', async () => {
  const provider = new FakeProvider([{ content: 'the answer is 4', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  const result = await loop.run('what is 2+2');
  assert.equal(result, 'the answer is 4');
  assert.equal(provider.callCount, 1);
});

test('addNotice keeps a UI note in history without sending it to the model or counting it toward context', () => {
  const loop = new AgentLoop(new FakeProvider([]), [], 'system');
  loop.addNotice('x'.repeat(4000));
  assert.equal(loop.getEntries().length, 1, 'the note must be kept in history so the session saves it');
  assert.equal(loop.getMessages().length, 0, 'the note must never reach the model');
  assert.equal(loop.getVisibleTokenEstimate(), 0, 'the note must not count toward the context estimate');
});

// The real failure of 2026-10-06, as a loop-level regression test: `run_shell` returned 11,370,857
// chars from one `dir /s /b D:\AngelCode`, roughly 15x a 229,376-token window, in a single
// toolcallresponse. Every compaction/hard-stop guard sits downstream of that append and could only
// refuse to continue, so the session was dead on the second tool call. See tools/toolOutput.ts.
test('a tool result bigger than the window is bounded before it reaches history, the wire or the event stream', async () => {
  const { mkdtemp, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'o4c-bound-'));

  const huge = 'D:/AngelCode/research/file.py\n'.repeat(350_000); // ~10.5 MB
  const tool = makeFakeTool('run_shell', huge);
  const provider = new FakeProvider([
    {
      content: 'listing it',
      toolCalls: [{ id: 't1', name: 'run_shell', input: { command: 'dir /s /b' } }],
      stopReason: 'tool_use',
    },
    { content: 'that was a lot of files', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const events: Array<{ type: string; toolOutput?: string }> = [];
  const result = await loop.run('walk the tree', {
    contextWindow: 229_376,
    toolOutputDir: dir,
    onEvent: (event) => events.push({ type: event.type, toolOutput: event.toolOutput }),
  });

  // The turn CONTINUES - the point of the fix. Before it, the hard stop fired and returned early.
  assert.equal(result, 'that was a lot of files');
  assert.equal(provider.callCount, 2);

  const response = loop.getEntries().find((e) => e.sub_type === 'toolcallresponse');
  assert.ok(response, 'the tool result was appended');
  assert.ok(response.content.length <= 40_000, `entry was ${response.content.length} chars`);
  assert.match(response.content, /\[o4c truncated this output: 10,500,000 chars/);

  const toolResultEvent = events.find((e) => e.type === 'tool_result');
  assert.ok(toolResultEvent?.toolOutput);
  assert.ok(toolResultEvent.toolOutput.length <= 40_000, 'the run log and UI are bounded too');

  // The second request - what would actually have been sent to the server - is bounded.
  const secondRequest = provider.receivedRequests[1];
  const wireChars = JSON.stringify(secondRequest.messages).length;
  assert.ok(wireChars <= 60_000, `wire payload was ${wireChars} chars`);
  assert.ok(loop.getVisibleTokenEstimate() < 229_376, 'the whole visible context still fits the window');

  // Nothing is lost: the untruncated output is on disk, and the marker points at it.
  const spilled = await readdir(dir);
  assert.equal(spilled.length, 1);
  const full = await readFile(join(dir, spilled[0]), 'utf-8');
  assert.equal(full.length, huge.length);
  assert.ok(response.content.includes(spilled[0]), 'the marker names the spill file');
});

test('an over-budget tool result is still bounded when there is nowhere to spill it', async () => {
  const tool = makeFakeTool('run_shell', 'y'.repeat(500_000));
  const provider = new FakeProvider([
    {
      content: 'running',
      toolCalls: [{ id: 't1', name: 'run_shell', input: {} }],
      stopReason: 'tool_use',
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const result = await loop.run('go', { contextWindow: 229_376 });

  assert.equal(result, 'done');
  const response = loop.getEntries().find((e) => e.sub_type === 'toolcallresponse');
  assert.ok(response.content.length <= 40_000);
  assert.ok(!response.content.includes('Full output:'), 'no path is claimed when nothing was written');
});

test('a tool result is bounded even when no context window is known at all', async () => {
  const tool = makeFakeTool('run_shell', 'z'.repeat(2_000_000));
  const provider = new FakeProvider([
    {
      content: 'running',
      toolCalls: [{ id: 't1', name: 'run_shell', input: {} }],
      stopReason: 'tool_use',
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  await loop.run('go');

  const response = loop.getEntries().find((e) => e.sub_type === 'toolcallresponse');
  assert.ok(response.content.length <= 40_000, `entry was ${response.content.length} chars`);
});

test('a tool result within budget is appended byte-identical', async () => {
  const output = 'a modest result\nwith two lines\n';
  const tool = makeFakeTool('read_file', output);
  const provider = new FakeProvider([
    {
      content: 'reading',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'x.txt' } }],
      stopReason: 'tool_use',
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  await loop.run('go', { contextWindow: 229_376 });

  const response = loop.getEntries().find((e) => e.sub_type === 'toolcallresponse');
  assert.equal(response.content, output);
});
