import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { parseLessons, reflectPrompt } from '../session/reflect.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';

/** Plan 0006 D4: /reflect proposes lessons from finished tasks; nothing is saved without a pick. */

test('only finished tasks with an answer are offered, newest first', () => {
  const store = new InfiniteContextStore(join(mkdtempSync(join(tmpdir(), 'o4c-reflect-')), 'history.db'));
  store.ensureSession({ id: 's', title: 't', started_at: Date.now() });
  const a = store.startTask({ session_id: 's', request: 'fix the build' });
  store.setTaskAnswer(a.id, 'Fixed: pnpm, not npm.');
  store.finishTask(a.id);
  const b = store.startTask({ session_id: 's', request: 'still open' });
  store.setTaskAnswer(b.id, 'half done');
  const c = store.startTask({ session_id: 's', request: 'no answer' });
  store.finishTask(c.id);
  const recent = store.recentFinishedTasks();
  assert.deepEqual(recent.map((t) => t.request), ['fix the build']);
  assert.match(reflectPrompt(recent), /Task 1: fix the build\nAnswer: Fixed: pnpm, not npm\./);
  store.close();
});

test('lessons are parsed from the JSON reply, at most three, and a bad reply is nothing', () => {
  assert.deepEqual(parseLessons('{"lessons": ["Use pnpm.", " ", "Tests need DB_URL set.", "x", "y"]}'), ['Use pnpm.', 'Tests need DB_URL set.', 'x']);
  assert.deepEqual(parseLessons('not json'), []);
  assert.deepEqual(parseLessons('{"other": 1}'), []);
});

test('the side request is standalone: no conversation, no tools, the side slot, the schema', async () => {
  const provider = new FakeProvider([{ content: '{"lessons": ["Use pnpm."]}', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  const reply = await loop.sideRequest('what to remember?', { responseSchema: { type: 'object' } });
  assert.equal(reply, '{"lessons": ["Use pnpm."]}');
  const req = provider.receivedRequests[0]!;
  assert.deepEqual(req.messages, [{ role: 'user', content: 'what to remember?' }]);
  assert.deepEqual(req.tools, []);
  assert.equal(req.purpose, 'side');
  assert.deepEqual(req.responseSchema, { type: 'object' });
  assert.equal(loop.getEntries().length, 0);
});
