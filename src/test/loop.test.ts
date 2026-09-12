import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, MaxIterationsError } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

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
