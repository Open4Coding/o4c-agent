import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

/** Plan 0006 C8: /btw asks about the conversation without adding to it. */

test('the side request is the next turn\'s prefix plus the question, tools off; history is untouched', async () => {
  const provider = new FakeProvider([
    { content: 'The bug is in parse().', toolCalls: [], stopReason: 'end_turn' },
    { content: '<think>short</think>parse() is in src/parser.ts.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [makeFakeTool('read_file', 'x')], 'system prompt');
  await loop.run('where is the bug?');
  const entriesBefore = loop.getEntries().length;

  const answer = await loop.askAside('which file was that in?');
  assert.equal(answer, 'parse() is in src/parser.ts.');
  const [main, side] = provider.receivedRequests;
  assert.equal(side!.systemPrompt, main!.systemPrompt);
  assert.deepEqual(side!.tools, main!.tools);
  assert.equal(side!.toolChoice, 'none');
  assert.deepEqual(side!.messages.slice(0, main!.messages.length), main!.messages, 'same prefix as the conversation');
  assert.deepEqual(side!.messages.at(-1), { role: 'user', content: 'which file was that in?' });
  assert.equal(loop.getEntries().length, entriesBefore, 'nothing added to history');
});
