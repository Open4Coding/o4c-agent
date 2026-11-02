import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRules, evaluateRules, loadRules, type PermissionRules } from '../session/permissionRules.js';
import { splitShellSegments } from '../tools/interactive.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 C3: allow / ask / deny rules per scope; shell commands judged per segment. */

const tool = (name: string): Tool => ({ name, description: '', inputSchema: {}, mutating: true, execute: async () => '' });
const shell = tool('run_shell');
const decide = (rules: PermissionRules, t: Tool, input: Record<string, unknown>) => evaluateRules(rules, t, input, splitShellSegments)?.decision;

const scopes = (files: Record<string, unknown>) => async (scope: string) => (files[scope] ?? {}) as Record<string, unknown>;

test('rules add up across scopes, each remembering where it came from; read-only shell only when switched on', async () => {
  const rules = await loadRules(
    scopes({
      global: { permissions: { allow: ['run_shell(npm test*)'], deny: ['run_shell(rm -rf*)'] } },
      local: { permissions: { allow: ['edit_file(src/**)'], ask: ['run_shell(git push*)'] } },
    }),
  );
  assert.deepEqual(rules.allow.map((r) => `${r.pattern}@${r.scope}`), ['run_shell(npm test*)@global', 'edit_file(src/**)@local']);
  assert.match(describeRules(rules).join('\n'), /^deny:\n {2}run_shell\(rm -rf\*\) +\(global\)\nask:\n {2}run_shell\(git push\*\) +\(local\)\nallow:/);
  assert.equal(decide(rules, shell, { command: 'git status' }), undefined);
  const withReadOnly = await loadRules(scopes({ global: { autoAllowReadOnly: true } }));
  assert.equal(decide(withReadOnly, shell, { command: 'git status' }), 'allow');
  assert.equal(decide(withReadOnly, shell, { command: 'git status && git push' }), undefined, 'every segment must be read-only');
});

test('deny beats ask beats allow; a shell command is judged per segment', async () => {
  const rules = await loadRules(
    scopes({ global: { permissions: { allow: ['run_shell(npm *)', 'edit_file(src/**)'], ask: ['run_shell(npm publish*)'], deny: ['run_shell(rm -rf*)'] } } }),
  );
  assert.equal(decide(rules, shell, { command: 'npm test' }), 'allow');
  assert.equal(decide(rules, shell, { command: 'npm publish' }), 'ask');
  assert.equal(decide(rules, shell, { command: 'npm test && rm -rf ~' }), 'deny');
  assert.equal(decide(rules, shell, { command: 'npm test; echo done' }), undefined, 'one segment not allowed -> no allow');
  assert.equal(decide(rules, shell, { command: 'npm test | tee out.txt' }), undefined);
  assert.equal(decide(rules, tool('edit_file'), { path: 'src/a/b.ts' }), 'allow');
  assert.equal(decide(rules, tool('edit_file'), { path: 'package.json' }), undefined);
});

test('a rule denial tells the model which rule, and not to route around it', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 'c1', name: 'run_shell', input: { command: 'rm -rf build' } }], stopReason: 'tool_use' },
    { content: 'ok', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [{ ...makeFakeTool('run_shell', 'x'), mutating: true }], 'system');
  await loop.run('clean', { toolPolicy: async () => ({ verdict: 'deny', reason: 'the permission rule run_shell(rm -rf*) (global) denies this' }) });
  assert.match(JSON.stringify(provider.receivedRequests[1]!.messages), /Blocked: the permission rule run_shell\(rm -rf\*\) \(global\) denies this\. run_shell was not executed\. Do not try to get the same effect another way\./);
});
