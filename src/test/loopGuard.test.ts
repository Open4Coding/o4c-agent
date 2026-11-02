import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, REPEAT_STOP } from '../agent/loopGuard.js';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { CompletionResponse } from '../providers/types.js';

test('same call, same result: a note at 3, a firmer one at 5, refused at 8; key order does not matter', () => {
  const g = new LoopGuard();
  const notes = [1, 2, 3, 4, 5, 6, 7].map((i) => g.record('grep_files', i % 2 ? { pattern: 'x', path: '.' } : { path: '.', pattern: 'x' }, 'No matches'));
  assert.equal(notes[0], undefined);
  assert.equal(notes[1], undefined);
  assert.match(notes[2]!, /3rd time this turn this exact grep_files call/);
  assert.match(notes[4]!, /made this exact grep_files call 5 times/);
  assert.match(g.refuse('grep_files', { pattern: 'x', path: '.' })!, /Not run: .* 7 times/);
  assert.equal(g.refuse('grep_files', { pattern: 'y', path: '.' }), undefined);
  assert.equal(REPEAT_STOP, 8);
});

test('the same call with a different result each time is progress, not a loop', () => {
  const g = new LoopGuard();
  for (let i = 0; i < 10; i++) assert.equal(g.record('run_shell', { command: 'npm test' }, `fail ${10 - i}`), undefined);
});

test('A-B-A-B alternation and a streak of identical results are noted', () => {
  const g = new LoopGuard();
  const seq = ['a', 'b', 'a'].map((x) => g.record('edit_file', { path: x }, `edited ${x}`));
  assert.ok(seq.every((n) => n === undefined));
  assert.match(g.record('edit_file', { path: 'b' }, 'edited b')!, /alternate between the same two calls/);

  const s = new LoopGuard();
  const notes = ['a', 'b', 'c', 'd', 'e'].map((x) => s.record('grep_files', { pattern: x }, 'No matches'));
  assert.match(notes[4]!, /last 5 calls all returned exactly this result/);
});

test('the loop appends the note to the result and ends the turn when a call is refused', async () => {
  let runs = 0;
  const tool = { ...makeFakeTool('read_file', 'same'), execute: async () => ((runs += 1), 'same') };
  const call = (id: string): CompletionResponse => ({ content: '', toolCalls: [{ id, name: 'read_file', input: { path: 'a' } }], stopReason: 'tool_use' });
  const provider = new FakeProvider([...Array.from({ length: 9 }, (_, i) => call(`c${i}`)), { content: 'never', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [tool], 'system');
  const events: AgentEvent[] = [];
  await loop.run('go', { onEvent: (e) => events.push(e) });
  assert.equal(runs, 7, 'the 8th identical call was not run');
  assert.equal(provider.callCount, 8, 'the turn ended after the refusal');
  assert.ok(events.some((e) => e.type === 'warning' && /kept making the same call/.test(e.text ?? '')));
  const results = loop.getEntries().filter((e) => e.sub_type === 'toolcallresponse').map((e) => e.content);
  assert.match(results[2]!, /^same\n\[o4c\] This is the 3rd time/);
  assert.match(results[7]!, /^\[o4c\] Not run/);
});
