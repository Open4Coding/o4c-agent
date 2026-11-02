import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, STEER_TAG, type AgentEvent } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

/** Plan 0006 C6: text typed during a turn reaches the model at its next step. */

test('steering goes in before the next model step, as a tagged user message, and is announced', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }], stopReason: 'tool_use' },
    { content: 'Using pnpm then.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const pending = ['use pnpm, not npm'];
  const events: AgentEvent[] = [];
  const loop = new AgentLoop(provider, [makeFakeTool('read_file', 'x')], 'system');
  await loop.run('set up the project', { takeSteering: () => pending.splice(0), onEvent: (e) => events.push(e) });

  assert.equal(JSON.stringify(provider.receivedRequests[0]!.messages).includes('pnpm'), false, 'not before the first step');
  const second = provider.receivedRequests[1]!.messages;
  assert.match(JSON.stringify(second[second.length - 1]), /\[Typed by the user while you were working:\] use pnpm, not npm/);
  assert.ok(loop.getEntries().some((e) => e.tags?.includes(STEER_TAG)));
  assert.ok(events.some((e) => e.type === 'info' && /Steering given to the model: use pnpm/.test(e.text ?? '')));
  assert.deepEqual(pending, [], 'taken once');
});
