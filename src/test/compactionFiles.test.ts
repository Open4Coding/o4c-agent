import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiCompactionEntry, aiToolCallEntry, aiToolCallResponseEntry, fileActivity, toWireMessages, userInputEntry } from '../agent/contextEntry.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';

/** Plan 0006 D7: compaction keeps the files read and changed, from the tool calls themselves. */

const call = (id: string, name: string, path: string) => [aiToolCallEntry({ id, name, input: { path } }, name !== 'read_file'), aiToolCallResponseEntry(id, 'ok', false)];

test('file activity comes from the tool calls and survives compaction after compaction', () => {
  const earlier = aiCompactionEntry({ user_intent: 'x' }, undefined, 100, { read: ['old.ts'], modified: ['older.ts'] });
  const entries = [earlier, ...call('1', 'read_file', 'src/a.ts'), ...call('2', 'edit_file', 'src/a.ts'), ...call('3', 'write_file', 'src/b.ts'), ...call('4', 'run_shell', 'x')];
  assert.deepEqual(fileActivity(entries), { read: ['old.ts', 'src/a.ts'], modified: ['older.ts', 'src/a.ts', 'src/b.ts'] });
});

test('the model is shown the lists with the summary', () => {
  const entry = aiCompactionEntry({ user_intent: 'fix login' }, undefined, 100, { read: ['src/a.ts'], modified: ['src/b.ts'] });
  const text = JSON.stringify(toWireMessages([userInputEntry('hi'), entry]));
  assert.match(text, /Files changed before this point: src\/b\.ts/);
  assert.match(text, /Files read before this point: src\/a\.ts/);
});

test('automatic compaction hides superseded reads first and summarizes nothing when that is enough', async () => {
  const big = 'z'.repeat(2400);
  const provider = new FakeProvider([{ content: 'answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries([
    userInputEntry('look'),
    aiToolCallEntry({ id: 'r1', name: 'read_file', input: { path: 'a.js' } }, false), aiToolCallResponseEntry('r1', big, false),
    aiToolCallEntry({ id: 'r2', name: 'read_file', input: { path: 'a.js' } }, false), aiToolCallResponseEntry('r2', big, false),
  ]);
  await loop.run('next', { contextWindow: 2000, compactionSettings: { reserveTokens: 900, keepRecentTokens: 100, microCompactReserveTokens: -1_000_000 } });
  assert.equal(provider.callCount, 1, 'no summary call');
  assert.ok(!loop.getEntries().some((e) => e.sub_type === 'compaction'));
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'prune'));
});
