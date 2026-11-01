import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contextTypeComponent, currentTurnStart, recentTurnsStart } from '../agent/contextTypeComponent.js';
import { contextWindowTypeControl, type ContextWindowType } from '../agent/contextWindowType.js';
import {
  CONTINUATION_TAG,
  aiResponseEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  systemNoticeEntry,
  userInputEntry,
  type ContextEntry,
} from '../agent/contextEntry.js';

/** NextUp item 23, checklist B2/B5/B6 - what each type sends. Pure projection tests, no loop. */

function conversation(): ContextEntry[] {
  return [
    systemNoticeEntry('Resumed session: tetris'),
    userInputEntry('first request'),
    aiResponseEntry('first answer'),
    userInputEntry('second request'),
    aiResponseEntry('second answer'),
    userInputEntry('third request'),
    aiResponseEntry('third answer'),
    userInputEntry('current request'),
    aiToolCallEntry({ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }, false),
    aiToolCallResponseEntry('c1', 'file text', false),
    { ...userInputEntry('Continue with the task.'), tags: [CONTINUATION_TAG] },
  ];
}

async function build(type: ContextWindowType, entries: readonly ContextEntry[], retrieval?: Parameters<typeof contextTypeComponent>[0]['retrieval']) {
  const component = contextTypeComponent({ control: contextWindowTypeControl(type), retrieval, curatedBudget: () => 1000 });
  return component.buildRequest!({ entries, contextWindow: 100_000 });
}

test('turn helpers find the current turn and skip the loop\'s own continue nudge', () => {
  const entries = conversation();
  assert.equal(entries[currentTurnStart(entries)].content, 'current request');
  assert.equal(entries[recentTurnsStart(entries, 3)].content, 'second request');
  assert.equal(entries[recentTurnsStart(entries, 99)].content, 'first request', 'fewer turns than asked: the earliest real message, never the notice');
  assert.equal(currentTurnStart([systemNoticeEntry('x')]), -1);
});

test('none: only the current turn, with its own tool calls and the continue nudge', async () => {
  const sent = await build({ type: 'none' }, conversation());
  assert.deepEqual(sent.map((e) => e.content.slice(0, 15)), ['current request', '{"name":"read_f', 'file text', 'Continue with t']);
});

test('floating: everything, untouched (sizing is /window\'s job)', async () => {
  const entries = conversation();
  assert.equal(await build({ type: 'floating' }, entries), entries);
});

test('pointer: the hint is added to the current message only, once per turn', async () => {
  let searches = 0;
  const retrieval = {
    pointerHint: (request: string) => {
      searches += 1;
      return `[hint for: ${request}]`;
    },
  };
  const control = contextWindowTypeControl({ type: 'pointer' });
  const component = contextTypeComponent({ control, retrieval });
  const entries = conversation();
  const first = await component.buildRequest!({ entries });
  await component.buildRequest!({ entries });
  assert.equal(searches, 1, 'many requests in one turn, one search');
  const current = first.find((e) => e.content.startsWith('current request'))!;
  assert.equal(current.content, 'current request\n\n[hint for: current request]');
  assert.equal(first.length, entries.length);
  assert.equal(entries[7].content, 'current request', 'history itself is never changed');
});

test('pointer with nothing qualifying sends exactly what floating would', async () => {
  const entries = conversation();
  assert.equal(await build({ type: 'pointer' }, entries, { pointerHint: () => undefined }), entries);
});

test('curated: the last three exchanges verbatim, with the loaded history in front of the first of them', async () => {
  let budgetSeen: number | undefined;
  const sent = await build({ type: 'curated' }, conversation(), {
    curatedHistory: async (_request, budget) => {
      budgetSeen = budget;
      return '[loaded history]';
    },
  });
  assert.equal(budgetSeen, 1000);
  assert.equal(sent[0].content, '[loaded history]\n\nsecond request');
  assert.deepEqual(sent.slice(1, 4).map((e) => e.content), ['second answer', 'third request', 'third answer']);
  assert.ok(!sent.some((e) => e.content.startsWith('first')), 'older turns are left out');
});

test('without retrieval, pointer and curated fall back to floating rather than failing', async () => {
  const entries = conversation();
  assert.equal(await build({ type: 'pointer' }, entries), entries);
  assert.equal(await build({ type: 'curated' }, entries), entries);
});
