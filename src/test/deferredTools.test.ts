import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, CALL_TOOL, LOAD_TOOLS } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 D8: many MCP tools are deferred behind load_tools / call_tool; the tool list stays fixed. */

function mcpTools(n: number, ran: string[]): Tool[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `mcp__srv__tool${i}`,
    description: `Does thing ${i}. More detail here.`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async (input: Record<string, unknown>) => (ran.push(`tool${i}:${String(input.q)}`), `result ${i}`),
  }));
}

test('above the threshold: two proxies instead of the MCP schemas; load_tools lists and loads; call_tool runs the real tool', async () => {
  const ran: string[] = [];
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 'a', name: LOAD_TOOLS, input: { search: 'thing 3' } }], stopReason: 'tool_use' },
    { content: '', toolCalls: [{ id: 'b', name: LOAD_TOOLS, input: { names: ['mcp__srv__tool3'] } }], stopReason: 'tool_use' },
    { content: '', toolCalls: [{ id: 'c', name: CALL_TOOL, input: { name: 'mcp__srv__tool3', arguments: { q: 'hi' } } }], stopReason: 'tool_use' },
    { content: '', toolCalls: [{ id: 'd', name: CALL_TOOL, input: { name: 'mcp__srv__tool3', arguments: {} } }], stopReason: 'tool_use' },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [makeFakeTool('read_file', 'x'), ...mcpTools(25, ran)], 'system');
  loop.deferToolsAbove = 20;
  await loop.run('use the server');

  const names = provider.receivedRequests[0]!.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['call_tool', 'load_tools', 'read_file']);
  assert.ok(provider.receivedRequests.every((r) => JSON.stringify(r.tools) === JSON.stringify(provider.receivedRequests[0]!.tools)), 'the tool list never changes');
  const results = loop.getEntries().filter((e) => e.sub_type === 'toolcallresponse').map((e) => e.content);
  assert.match(results[0]!, /^1 tool\(s\).*\n- mcp__srv__tool3: Does thing 3\.$/s);
  assert.match(results[1]!, /"name":"mcp__srv__tool3".*"input_schema"/);
  assert.equal(results[2], 'result 3');
  assert.match(results[3]!, /missing required argument "q"/, 'B4 checks apply to the real tool');
  assert.deepEqual(ran, ['tool3:hi']);
  // History keeps the call as the model wrote it.
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'toolcall' && e.content.includes('"name":"call_tool"')));
});

test('at or under the threshold nothing is deferred', async () => {
  const provider = new FakeProvider([{ content: 'ok', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, mcpTools(5, []), 'system');
  await loop.run('x');
  assert.equal(provider.receivedRequests[0]!.tools.length, 5);
});
