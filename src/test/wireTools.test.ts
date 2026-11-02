import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import type { CompletionRequest, CompletionResponse, LLMProvider, ToolCall } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 A6: the tool list sent to the model is stable - sorted, changed only between user
 * turns, never shrunk mid-session, and the same after a reload. */

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} },
  mutating: false,
  execute: async () => `${name} ran`,
});

class Recorder implements LLMProvider {
  readonly name = 'recorder';
  requests: CompletionRequest[] = [];
  nextCall: ToolCall | undefined;
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    if (this.nextCall) {
      const call = this.nextCall;
      this.nextCall = undefined;
      return { content: '', toolCalls: [call], stopReason: 'tool_use' };
    }
    return { content: 'ok', toolCalls: [], stopReason: 'end_turn' };
  }
}

const names = (r: CompletionRequest) => r.tools.map((t) => t.name);

test('sorted: built-ins by name, then MCP tools by name, whatever order they were added in', async () => {
  const p = new Recorder();
  const loop = new AgentLoop(p, [tool('write_file'), tool('read_file')], 's');
  loop.addTools([tool('mcp__b__x'), tool('code_graph'), tool('mcp__a__y')]);
  await loop.run('hi');
  assert.deepEqual(names(p.requests[0]!), ['code_graph', 'read_file', 'write_file', 'mcp__a__y', 'mcp__b__x']);
});

test('a tool added mid-turn waits for the next user turn, and the change is announced once', async () => {
  const p = new Recorder();
  const loop = new AgentLoop(p, [tool('read_file')], 's');
  const events: AgentEvent[] = [];
  p.nextCall = { id: 'c1', name: 'read_file', input: {} };
  const late = tool('mcp__srv__late');
  const realExecute = loop['tools'][0]!.execute;
  loop['tools'][0]!.execute = async (input) => {
    loop.addTools([late]); // connects while the turn is running
    return realExecute(input);
  };
  await loop.run('one', { onEvent: (e) => events.push(e) });
  assert.deepEqual(names(p.requests[1]!), ['read_file'], 'same list for the rest of the turn');
  await loop.run('two', { onEvent: (e) => events.push(e) });
  assert.deepEqual(names(p.requests[2]!), ['read_file', 'mcp__srv__late']);
  const infos = events.filter((e) => e.type === 'info' && /Tools changed/.test(e.text ?? ''));
  assert.equal(infos.length, 1);
  assert.match(infos[0]!.text!, /mcp__srv__late/);
});

test('a removed tool stays listed (no re-read) and is refused with a clear message', async () => {
  const p = new Recorder();
  const loop = new AgentLoop(p, [tool('read_file'), tool('code_graph')], 's');
  await loop.run('one');
  loop.removeTools(['code_graph']);
  p.nextCall = { id: 'c2', name: 'code_graph', input: {} };
  await loop.run('two');
  assert.deepEqual(names(p.requests[1]!), ['code_graph', 'read_file'], 'unchanged');
  const result = p.requests[2]!.messages.find((m) => m.role === 'tool');
  assert.match(String(result?.content), /code_graph is not available right now/);
});

test('a reload sends the recorded list even when an MCP server has not connected this time', async () => {
  const p = new Recorder();
  const first = new AgentLoop(p, [tool('read_file')], 's');
  first.addTools([tool('mcp__srv__x')]);
  await first.run('one');
  const saved = first.getEntries();
  assert.ok(saved.some((e) => e.type === 'system' && e.sub_type === 'tools'), 'MCP tools present: snapshot recorded');

  const reloaded = new AgentLoop(p, [tool('read_file')], 's'); // the server is not up yet
  reloaded.loadEntries(saved);
  await reloaded.run('two');
  assert.deepEqual(names(p.requests[1]!), ['read_file', 'mcp__srv__x']);
});

test('built-ins alone leave no snapshot in history', async () => {
  const loop = new AgentLoop(new Recorder(), [tool('read_file')], 's');
  await loop.run('one');
  assert.ok(!loop.getEntries().some((e) => e.sub_type === 'tools'));
});
