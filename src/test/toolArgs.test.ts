import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs, closestNames, resolveTool, unknownToolMessage, type SchemaTool } from '../agent/toolArgs.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

const READ: SchemaTool = {
  name: 'read_file',
  inputSchema: { properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'integer' }, raw: { type: 'boolean' }, tags: { type: 'array' } }, required: ['path'] },
};
const NAMES = ['read_file', 'write_file', 'edit_file', 'run_shell', 'glob_files', 'grep_files'];

test('names: exact, then unambiguous after case and -/_ folding; suggestions for the rest', () => {
  const tools = NAMES.map((name) => ({ name }));
  assert.equal(resolveTool('read_file', tools)?.name, 'read_file');
  assert.equal(resolveTool('Read-File', tools)?.name, 'read_file');
  assert.equal(resolveTool('readfile', tools)?.name, 'read_file');
  assert.equal(resolveTool('read', tools), undefined);
  assert.deepEqual(closestNames('read', NAMES), ['read_file']);
  assert.deepEqual(closestNames('grep', NAMES), ['grep_files']);
  assert.deepEqual(closestNames('bash', NAMES), []);
  assert.match(unknownToolMessage('edit', NAMES), /no tool named "edit"\. Did you mean "edit_file"\? Available tools: read_file, write_file/);
});

test('arguments: obvious coercions applied, missing and wrong-typed ones refused, strays ignored', () => {
  assert.deepEqual(checkArgs({ path: 'a', offset: '10', limit: '5', raw: 'true', tags: '["x"]', extra: 1 }, READ), {
    input: { path: 'a', offset: 10, limit: 5, raw: true, tags: ['x'], extra: 1 },
    errors: [],
  });
  assert.deepEqual(checkArgs({ path: 7 }, READ).input, { path: '7' });
  assert.deepEqual(checkArgs({ file_path: 'a.ts' }, READ).errors, ['missing required argument "path" (you passed "file_path" - did you mean "path"?)']);
  assert.deepEqual(checkArgs({}, READ).errors, ['missing required argument "path"']);
  assert.deepEqual(checkArgs({ path: 'a', limit: '2.5', raw: 'yes' }, READ).errors, ['"limit" must be an integer, not "2.5"', '"raw" must be a boolean, not "yes"']);
});

test('the loop runs a near-miss name with coerced arguments, and refuses bad ones before approval', async () => {
  const seen: unknown[] = [];
  const base = makeFakeTool('read_file', 'ok');
  const tool = { ...base, inputSchema: READ.inputSchema as typeof base.inputSchema, execute: async (input: Record<string, unknown>) => (seen.push(input), 'ok') };
  let asked = 0;
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [
        { id: 'a', name: 'Read_File', input: { path: 'x', offset: '3' } },
        { id: 'b', name: 'read_file', input: { file_path: 'x' } },
        { id: 'c', name: 'reed', input: {} },
      ],
      stopReason: 'tool_use',
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');
  await loop.run('go', { toolPolicy: async () => ((asked += 1), 'allow') });
  assert.deepEqual(seen, [{ path: 'x', offset: 3 }]);
  assert.equal(asked, 1, 'only the valid call reached approval');
  const sent = JSON.stringify(provider.receivedRequests[1]!.messages);
  assert.match(sent, /this read_file call was not run: missing required argument \\"path\\" \(you passed \\"file_path\\"/);
  assert.match(sent, /no tool named \\"reed\\"\. Did you mean \\"read_file\\"/);
});
