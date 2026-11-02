import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { CompletionResponse } from '../providers/types.js';

/** Plan 0006 B19: a turn that ends after unchecked edits is asked, once, to verify them. */

const edit = { ...makeFakeTool('edit_file', 'Edited a.js'), mutating: true };
const shell = makeFakeTool('run_shell', 'tests pass');
const call = (id: string, name: string): CompletionResponse => ({ content: '', toolCalls: [{ id, name, input: {} }], stopReason: 'tool_use' });
const answer = (text: string): CompletionResponse => ({ content: text, toolCalls: [], stopReason: 'end_turn' });

test('edits with nothing run after them: one nudge, then the turn may end', async () => {
  const provider = new FakeProvider([call('e1', 'edit_file'), answer('Fixed.'), call('r1', 'run_shell'), answer('Fixed and the tests pass.')]);
  const events: AgentEvent[] = [];
  const loop = new AgentLoop(provider, [edit, shell], 'system');
  assert.equal(await loop.run('fix it', { verifyOnStop: true, onEvent: (e) => events.push(e) }), 'Fixed and the tests pass.');
  assert.ok(events.some((e) => e.type === 'warning' && /changed files but ran nothing/.test(e.text ?? '')));
  assert.match(JSON.stringify(provider.receivedRequests[2]!.messages), /You changed files but have not run anything/);

  // Asked once: a model that still does not run anything is not nagged again.
  const stubborn = new FakeProvider([call('e1', 'edit_file'), answer('Fixed.'), answer('There is no test runner here.')]);
  assert.equal(await new AgentLoop(stubborn, [edit, shell], 'system').run('fix it', { verifyOnStop: true }), 'There is no test runner here.');
});

test('no nudge when a command ran after the last edit, when nothing changed, or when the option is off', async () => {
  const ranAfter = new FakeProvider([call('e1', 'edit_file'), call('r1', 'run_shell'), answer('Done.')]);
  assert.equal(await new AgentLoop(ranAfter, [edit, shell], 'system').run('x', { verifyOnStop: true }), 'Done.');
  assert.equal(ranAfter.callCount, 3);

  const readOnly = new FakeProvider([call('r1', 'run_shell'), answer('It says hello.')]);
  assert.equal(await new AgentLoop(readOnly, [edit, shell], 'system').run('x', { verifyOnStop: true }), 'It says hello.');

  const off = new FakeProvider([call('e1', 'edit_file'), answer('Fixed.')]);
  assert.equal(await new AgentLoop(off, [edit, shell], 'system').run('x'), 'Fixed.');
});
