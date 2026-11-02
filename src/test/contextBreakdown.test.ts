import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextBreakdown, formatBreakdown } from '../agent/contextBreakdown.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

/** Plan 0006 D5: /context says where a request's tokens go. */

test('buckets: system prompt by section, tools by kind, earlier conversation by kind, current turn', () => {
  const buckets = contextBreakdown(
    {
      systemPrompt: 'x'.repeat(400),
      tools: [
        { name: 'read_file', description: 'd'.repeat(40), inputSchema: {} },
        { name: 'code_graph', description: 'g'.repeat(40), inputSchema: {} },
        { name: 'mcp__github__issues', description: 'm'.repeat(80), inputSchema: {} },
      ],
      messages: [
        { role: 'user', content: 'u'.repeat(80) },
        { role: 'assistant', content: 'a'.repeat(40), toolCalls: [{ id: '1', name: 'read_file', input: { path: 'p' } }] },
        { role: 'tool', content: 'r'.repeat(400), toolCallId: '1' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'now this' },
      ],
    },
    [
      { name: 'identity', text: 'i'.repeat(200) },
      { name: 'environment', text: 'e'.repeat(40) },
      { name: 'project', text: 'p'.repeat(120) },
    ],
  );
  const by = Object.fromEntries(buckets.map((b) => [b.label.replace(/ \(.*\)$/, ''), b.tokens]));
  assert.equal(by['System prompt'], 100);
  assert.equal(by['project instructions'], 30);
  assert.equal(by['tool results'], 100);
  assert.equal(by['your messages'], 20);
  assert.ok(by['MCP servers'] > 0 && by['built-in'] > 0);
  assert.ok(buckets.some((b) => /^o4c features \(code_graph\)$/.test(b.label)));
  assert.match(buckets.find((b) => b.label.startsWith('Current turn'))!.label, /\(1 messages\)/);
  const text = formatBreakdown(buckets).join('\n');
  assert.match(text, /^ {2}Where the tokens go \(estimated, [\d,]+ in all\):\n {4}System prompt: 100 \d+%/);
});

test('a fresh process previews the request from history and its tools', async () => {
  const loop = new AgentLoop(new FakeProvider([{ content: 'hi', toolCalls: [], stopReason: 'end_turn' }]), [makeFakeTool('read_file', 'x')], 'the prompt');
  const before = loop.previewRequest();
  assert.equal(before.systemPrompt, 'the prompt');
  assert.deepEqual(before.tools.map((t) => t.name), ['read_file']);
  await loop.run('hello');
  assert.ok(loop.previewRequest().messages.some((m) => m.content === 'hello'));
});
