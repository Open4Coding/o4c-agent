import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConfirmDialog, type ConfirmChoice } from '../ui/ConfirmDialog.js';
import { matchesPattern, patternFor } from '../session/permissionRules.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 C2: No / Yes / Always allow / No and tell the model why, with hotkeys. */

const tick = () => new Promise((r) => setTimeout(r, 30));

async function dialog(keys: string[]): Promise<{ choice?: ConfirmChoice; reason?: string; frame: string }> {
  let got: { choice?: ConfirmChoice; reason?: string } = {};
  const { stdin, lastFrame } = render(
    <ConfirmDialog message="Run npm test?" onResolve={() => {}} onChoice={(choice, reason) => (got = { choice, reason })} alwaysLabel="run_shell(npm test*)" />,
  );
  await tick();
  const frame = lastFrame() ?? '';
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
  return { ...got, frame };
}

test('four rows, No first, with their hotkeys', async () => {
  const { frame } = await dialog([]);
  assert.match(frame, /> No \(n\)[^\n]*\n[^\n]*Yes \(y\)[^\n]*\n[^\n]*Yes, and always allow run_shell\(npm test\*\) \(a\)[^\n]*\n[^\n]*No, and tell the model why \(t\)/);
});

test('hotkeys and arrows choose; t asks for a reason, Enter sends it, Esc goes back', async () => {
  assert.equal((await dialog(['y'])).choice, 'yes');
  assert.equal((await dialog(['a'])).choice, 'always');
  assert.equal((await dialog(['n'])).choice, 'no');
  assert.equal((await dialog(['\u001b[B', '\u001b[B', '\r'])).choice, 'always');
  assert.equal((await dialog(['\r'])).choice, 'no', 'Enter on the default is the safe answer');
  assert.deepEqual(await dialog(['t', 'u', 's', 'e', ' ', 'p', 'n', 'p', 'm', '\r']).then(({ choice, reason }) => ({ choice, reason })), { choice: 'tell', reason: 'use pnpm' });
  assert.equal((await dialog(['t', 'x', '\u001b', 'y'])).choice, 'yes', 'Esc in the reason goes back to the choices');
});

test('the plain yes/no dialog keeps two rows and gets y/n', async () => {
  let resolved: boolean | undefined;
  const { stdin, lastFrame } = render(<ConfirmDialog message="Stop now?" onResolve={(ok) => (resolved = ok)} />);
  await tick();
  assert.doesNotMatch(lastFrame() ?? '', /always/);
  stdin.write('y');
  await tick();
  assert.equal(resolved, true);
});

const tool = (name: string): Tool => ({ name, description: '', inputSchema: {}, mutating: true, execute: async () => '' });

test('always-allow patterns: specific enough to be safe, general enough to help', () => {
  assert.equal(patternFor(tool('run_shell'), { command: 'npm test -- --watch' }), 'run_shell(npm test*)');
  assert.equal(patternFor(tool('run_shell'), { command: 'make' }), 'run_shell(make*)');
  assert.equal(patternFor(tool('edit_file'), { path: 'src/ui/App.tsx' }), 'edit_file(src/ui/**)');
  assert.equal(patternFor(tool('write_file'), { path: 'README.md' }), 'write_file(**)');
  assert.equal(patternFor(tool('job_output'), {}), 'job_output');

  assert.ok(matchesPattern('run_shell(npm test*)', tool('run_shell'), { command: 'npm test' }));
  assert.ok(matchesPattern('run_shell(npm test*)', tool('run_shell'), { command: 'npm test -- -t x' }));
  assert.ok(!matchesPattern('run_shell(npm test*)', tool('run_shell'), { command: 'npm install evil' }));
  assert.ok(matchesPattern('edit_file(src/ui/**)', tool('edit_file'), { path: 'src/ui/deep/x.ts' }));
  assert.ok(!matchesPattern('edit_file(src/ui/**)', tool('edit_file'), { path: 'src/agent/x.ts' }));
  assert.ok(!matchesPattern('edit_file(src/ui/**)', tool('write_file'), { path: 'src/ui/x.ts' }));
  assert.ok(matchesPattern('job_output', tool('job_output'), {}));
});

test("the model is told the user's reason with the decline", async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 'c1', name: 'run_shell', input: { command: 'npm i' } }], stopReason: 'tool_use' },
    { content: 'ok', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [{ ...makeFakeTool('run_shell', 'x'), mutating: true }], 'system');
  await loop.run('go', { toolPolicy: async () => ({ verdict: 'declined', reason: 'use pnpm, not npm' }) });
  assert.match(JSON.stringify(provider.receivedRequests[1]!.messages), /The user declined this run_shell call, so it was not executed, and said why: \\"use pnpm, not npm\\"/);
});
