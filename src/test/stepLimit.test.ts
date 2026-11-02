import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, MaxIterationsError, type AgentEvent } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { CompletionResponse } from '../providers/types.js';

/** Plan 0006 B18: a graceful step limit, and a nudge when the model announces a step and stops. */

let n = 0;
const step = (): CompletionResponse => ({ content: '', toolCalls: [{ id: `s${++n}`, name: 'work', input: { n } }], stopReason: 'tool_use' });
const tool = () => {
  let k = 0;
  return { ...makeFakeTool('work', 'ok'), execute: async () => `result ${++k}` };
};

test('summarize: one more request with tools off, and its answer ends the turn', async () => {
  const provider = new FakeProvider([step(), step(), step(), { content: 'Done: A and B. Left: C.', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [tool()], 'system');
  const asked: number[] = [];
  const answer = await loop.run('go', { maxIterations: 3, onStepLimit: async (s) => (asked.push(s), 'summarize') });
  assert.equal(answer, 'Done: A and B. Left: C.');
  assert.deepEqual(asked, [3]);
  const last = provider.receivedRequests[3]!;
  assert.equal(last.toolChoice, 'none');
  assert.equal(last.tools.length, 1, 'same tools, so the cached prefix holds');
  assert.match(JSON.stringify(last.messages), /step limit for this turn \(3 steps\) is reached/);
});

test('continue grants another block; stop (or no callback) ends with MaxIterationsError as before', async () => {
  const provider = new FakeProvider([step(), step(), step(), { content: 'finished', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [tool()], 'system');
  assert.equal(await loop.run('go', { maxIterations: 2, onStepLimit: async () => 'continue' }), 'finished');

  const stopping = new AgentLoop(new FakeProvider([step(), step(), step()]), [tool()], 'system');
  await assert.rejects(stopping.run('go', { maxIterations: 2, onStepLimit: async () => 'stop' }), MaxIterationsError);
});

test('"Next I will..." with no call after tool work gets one nudge; a sign-off does not', async () => {
  const provider = new FakeProvider([
    step(),
    { content: 'The parser is fixed. Next I will run the tests.', toolCalls: [], stopReason: 'end_turn' },
    { content: 'All tests pass.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const events: AgentEvent[] = [];
  const loop = new AgentLoop(provider, [tool()], 'system');
  assert.equal(await loop.run('go', { onEvent: (e) => events.push(e) }), 'All tests pass.');
  assert.ok(events.some((e) => e.type === 'warning' && /said what it would do next/.test(e.text ?? '')));

  const signOff = new FakeProvider([step(), { content: 'Fixed and tested.\nLet me know if you need anything else.', toolCalls: [], stopReason: 'end_turn' }]);
  const done = new AgentLoop(signOff, [tool()], 'system');
  assert.match(await done.run('go'), /Let me know/);
  assert.equal(signOff.callCount, 2);
});
