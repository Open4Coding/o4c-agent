import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supersededReadIds } from '../agent/supersededReads.js';
import { aiToolCallEntry, aiToolCallResponseEntry, userInputEntry, type ContextEntry } from '../agent/contextEntry.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';

function pair(id: string, name: string, input: Record<string, unknown>, output: string): ContextEntry[] {
  return [aiToolCallEntry({ id, name, input }, name !== 'read_file'), aiToolCallResponseEntry(id, output, name !== 'read_file')];
}

test('which reads are superseded: by a later full read, the same lines, or a full write - never by an edit', () => {
  const entries = [
    userInputEntry('task'),
    ...pair('c1', 'read_file', { path: 'a.js' }, 'v1'),
    ...pair('c2', 'read_file', { path: './a.js' }, 'v1'),
    ...pair('c3', 'read_file', { path: 'a.js', offset: 5 }, 'part'),
    ...pair('c4', 'edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' }, 'Edited'),
    ...pair('c5', 'read_file', { path: 'b.js' }, 'b'),
    ...pair('c6', 'write_file', { path: 'b.js', content: 'new b' }, 'Overwrote'),
    ...pair('c7', 'read_file', { path: 'a.js' }, 'v2'),
    ...pair('c8', 'read_file', { path: 'c.js' }, 'Error reading file "c.js": ENOENT'),
    ...pair('c9', 'read_file', { path: 'c.js' }, 'c'),
    ...pair('c10', 'read_file', { path: 'd.js', offset: 1, limit: 10 }, 'd1'),
    ...pair('c11', 'read_file', { path: 'd.js', offset: 20, limit: 10 }, 'd2'),
  ];
  assert.deepEqual(supersededReadIds(entries), ['c1', 'c5', 'c2', 'c3']);
});

test('MicroCompact hides duplicate reads first and stops there when that is enough; history keeps them whole', async () => {
  const big = 'x'.repeat(1600); // ~400 tokens a copy
  const entries = [
    userInputEntry('look at a.js'),
    ...pair('r1', 'read_file', { path: 'a.js' }, big),
    ...pair('u1', 'read_file', { path: 'notes.md' }, 'unique notes '.repeat(30)),
    ...pair('r2', 'read_file', { path: 'a.js' }, big),
    ...pair('r3', 'read_file', { path: 'a.js' }, big),
  ];
  const provider = new FakeProvider([{ content: 'answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(entries);
  await loop.run('go', { contextWindow: 1600, compactionSettings: { reserveTokens: 50, keepRecentTokens: 300, microCompactReserveTokens: 300 } });

  const after = loop.getEntries();
  const visibleIds = after.filter((e) => e.sub_type === 'toolcall' && e.agent_visible !== false).map((e) => e.tool_call_id);
  assert.deepEqual(visibleIds, ['u1', 'r3'], 'one copy of a.js, and the unique older read kept');
  const marker = after.find((e) => e.sub_type === 'prune');
  assert.match(marker!.content, /superseded file read/);
  // History keeps the hidden reads whole - only the request stops carrying them.
  assert.equal(after.find((e) => e.sub_type === 'toolcallresponse' && e.tool_call_id === 'r1')!.content, big);
  const sent = JSON.stringify(provider.receivedRequests[0]!.messages);
  assert.equal(sent.split(big).length - 1, 1, 'the request carries a.js once');
});
