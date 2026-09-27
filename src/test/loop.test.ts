import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, AbortedError, MaxIterationsError } from '../agent/loop.js';
import { aiResponseEntry, estimateTokens, userInputEntry } from '../agent/contextEntry.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { LLMProvider } from '../providers/types.js';

test('returns immediately when the model ends the turn with no tool calls', async () => {
  const provider = new FakeProvider([
    { content: 'the answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const result = await loop.run('hello');

  assert.equal(result, 'the answer');
  assert.equal(provider.callCount, 1);
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

  const events: string[] = [];
  await loop.run('go', { onEvent: (e) => events.push(e.type) });

  assert.deepEqual(events, ['text', 'tool_call', 'tool_result', 'text']);
});

test('a <think> block is split out: emitted as its own "think" event, and stripped from the final answer', async () => {
  const provider = new FakeProvider([
    { content: '<think>2+2 is basic addition</think>The answer is 4.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('what is 2+2?', {
    onEvent: (e) => events.push({ type: e.type, text: e.text }),
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
  const result = await loop.run('hi', { onEvent: (e) => events.push(e.type) });

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
