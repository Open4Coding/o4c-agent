import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../agent/loop.js';
import { aiResponseEntry, userInputEntry } from '../agent/contextEntry.js';
import { FakeProvider } from './fakeProvider.js';

/** Plan 0006 D6: /compact [focus] summarizes now, keeping what the user asked for. */

const summary = JSON.stringify({ goal: 'g', progress: 'p', decisions: [], files: ['src/auth.ts'], next: 'n' });

test('compacts whatever the size, with the focus in the summary request', async () => {
  const provider = new FakeProvider([{ content: summary, toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  const turns = [];
  for (let i = 0; i < 4; i++) turns.push(userInputEntry(`question ${i} ${'x'.repeat(800)}`), aiResponseEntry(`answer ${i} ${'y'.repeat(800)}`));
  loop.loadEntries(turns);
  const r = await loop.compactNow({ contextWindow: 200_000, focus: 'the auth bug and src/auth.ts' });
  assert.ok(r && r.after < r.before, JSON.stringify(r));
  assert.match(JSON.stringify(provider.receivedRequests[0]!.messages), /The user asked this summary to keep in detail: the auth bug and src\/auth\.ts/);
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'compaction'));
});

test('nothing to fold yet: undefined, and no model call', async () => {
  const provider = new FakeProvider([]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries([userInputEntry('only question'), aiResponseEntry('only answer')]);
  assert.equal(await loop.compactNow({ contextWindow: 200_000 }), undefined);
  assert.equal(provider.callCount, 0);
});
