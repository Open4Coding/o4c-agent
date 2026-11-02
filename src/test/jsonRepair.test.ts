import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairJson } from '../providers/jsonRepair.js';
import { parseSseStream } from '../providers/local.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

function stream(args: string, finish: string): ReadableStream<Uint8Array> {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: args } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
  ].join('');
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
}

test('repairJson: raw newlines and tabs inside strings, trailing commas; nothing else is guessed', () => {
  assert.deepEqual(repairJson('{"path": "a.py", "content": "def f():\n\treturn 1\n",}'), { path: 'a.py', content: 'def f():\n\treturn 1\n' });
  assert.deepEqual(repairJson('{"a": [1, 2,], "b": "x, }"}'), { a: [1, 2], b: 'x, }' });
  assert.deepEqual(repairJson('{"a": "already \\n escaped"}'), { a: 'already \n escaped' });
  assert.equal(repairJson("{'a': 1}"), undefined);
  assert.equal(repairJson('{"a": 1'), undefined);
  assert.equal(repairJson('[1, 2]'), undefined);
});

test('a call with repairable arguments runs; an unrepairable complete one is kept with its error; a cut-off one is still a cutoff', async () => {
  const fixed = await parseSseStream(stream('{"path": "a.txt", "content": "one\ntwo",}', 'tool_calls'));
  assert.deepEqual(fixed.toolCalls[0]!.input, { path: 'a.txt', content: 'one\ntwo' });
  assert.equal(fixed.toolCalls[0]!.argumentError, undefined);

  const broken = await parseSseStream(stream('{"path": "a.txt" "content": "x"}', 'tool_calls'));
  assert.equal(broken.toolCalls.length, 1);
  assert.deepEqual(broken.toolCalls[0]!.input, {});
  assert.match(broken.toolCalls[0]!.argumentError!, /they began: \{"path": "a\.txt" "content"/);
  assert.equal(broken.truncatedToolCall, undefined);

  const cut = await parseSseStream(stream('{"path": "a.txt", "content": "unfinished', 'length'));
  assert.deepEqual(cut.toolCalls, []);
  assert.equal(cut.truncatedToolCall?.name, 'write_file');
});

test('the loop does not run a call with an argument error and tells the model why', async () => {
  let ran = 0;
  const tool = { ...makeFakeTool('write_file', 'written'), execute: async () => ((ran += 1), 'written') };
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 'c1', name: 'write_file', input: {}, argumentError: 'Expected comma; they began: {"path"' }], stopReason: 'tool_use' },
    { content: 'Sorry, retrying later.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');
  await loop.run('write it');
  assert.equal(ran, 0);
  const sent = JSON.stringify(provider.receivedRequests[1]!.messages);
  assert.match(sent, /arguments of this write_file call were not valid JSON \(Expected comma; they began: \{\\"path\\"\), so it was not run/);
});
