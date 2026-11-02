import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverTextToolCalls, type ToolSchemaLike } from '../agent/textToolCalls.js';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

const TOOLS: ToolSchemaLike[] = [
  { name: 'read_file', inputSchema: { properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'integer' } } } },
  { name: 'edit_file', inputSchema: { properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } } } },
];

test('Qwen XML form, with and without the <tool_call> wrapper; typed by schema; indentation kept', () => {
  const text = [
    'Let me fix it.',
    '<tool_call>',
    '<function=edit_file>',
    '<parameter=path>',
    'src/a.js',
    '</parameter>',
    '<parameter=old_string>',
    '    if (x) {',
    '      return 1;',
    '</parameter>',
    '<parameter=new_string>',
    '    if (x) {',
    '      return 2;',
    '</parameter>',
    '<parameter=replace_all>',
    'false',
    '</parameter>',
    '</function>',
    '</tool_call>',
    '<function=read_file>',
    '<parameter=path>',
    'b.js',
    '</parameter>',
    '<parameter=offset>',
    '10',
    '</parameter>',
    '</function>',
  ].join('\n');
  const r = recoverTextToolCalls(text, TOOLS);
  assert.deepEqual(
    r.calls.map((c) => [c.name, c.input]),
    [
      ['edit_file', { path: 'src/a.js', old_string: '    if (x) {\n      return 1;', new_string: '    if (x) {\n      return 2;', replace_all: false }],
      ['read_file', { path: 'b.js', offset: 10 }],
    ],
  );
  assert.equal(r.text, 'Let me fix it.');
  assert.ok(r.calls.every((c) => c.id.startsWith('text_call_')) && r.calls[0]!.id !== r.calls[1]!.id);
});

test('Hermes JSON form and a fenced JSON call', () => {
  const hermes = recoverTextToolCalls('ok\n<tool_call>\n{"name": "read_file", "arguments": {"path": "x.ts"}}\n</tool_call>', TOOLS);
  assert.deepEqual(hermes.calls.map((c) => [c.name, c.input]), [['read_file', { path: 'x.ts' }]]);
  assert.equal(hermes.text, 'ok');
  const fenced = recoverTextToolCalls('```json\n{"name": "read_file", "arguments": "{\\"path\\": \\"y.ts\\"}"}\n```', TOOLS);
  assert.deepEqual(fenced.calls.map((c) => [c.name, c.input]), [['read_file', { path: 'y.ts' }]]);
});

test('not calls: prose naming a tool, an example inside a fence, an unknown tool, other JSON', () => {
  const cases = [
    'I will use read_file on src/a.js next, then edit_file.',
    'The format is:\n```\n<tool_call>\n<function=read_file>\n<parameter=path>\na\n</parameter>\n</function>\n</tool_call>\n```',
    '<tool_call>\n<function=delete_everything>\n<parameter=path>\n/\n</parameter>\n</function>\n</tool_call>',
    '```json\n{"name": "read_file", "version": 2}\n```',
    '```json\n{"name": "package", "arguments": {}}\n```',
  ];
  for (const text of cases) {
    const r = recoverTextToolCalls(text, TOOLS);
    assert.deepEqual(r.calls, [], text);
    assert.equal(r.text, text);
  }
});

test('the loop runs a call written as text and says so; with the setting off the text stays text', async () => {
  const tool = makeFakeTool('read_file', 'contents');
  const provider = new FakeProvider([
    { content: 'Reading.\n<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>', toolCalls: [], stopReason: 'end_turn' },
    { content: 'It says contents.', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');
  const events: AgentEvent[] = [];
  const answer = await loop.run('what is in a.txt?', { onEvent: (e) => events.push(e) });
  assert.equal(answer, 'It says contents.');
  assert.equal(provider.callCount, 2);
  assert.ok(events.some((e) => e.type === 'tool_call' && e.toolName === 'read_file'));
  assert.ok(events.some((e) => e.type === 'info' && /wrote as text \(read_file\)/.test(e.text ?? '')));
  // History holds a structured call and the prose without the block.
  const wire = provider.receivedRequests[1]!.messages;
  assert.ok(JSON.stringify(wire).includes('"name":"read_file"'));
  assert.ok(!JSON.stringify(wire).includes('<function=read_file>'));

  const off = new AgentLoop(new FakeProvider([{ content: '<function=read_file>\n<parameter=path>\na\n</parameter>\n</function>', toolCalls: [], stopReason: 'end_turn' }]), [tool], 'system');
  off.textToolCallRecovery = false;
  assert.match(await off.run('x'), /<function=read_file>/);
});
