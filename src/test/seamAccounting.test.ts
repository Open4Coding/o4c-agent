import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoop } from '../agent/loop.js';
import { userInputEntry, aiResponseEntry, type ContextEntry } from '../agent/contextEntry.js';
import { slidingWindowComponent } from '../agent/slidingWindow.js';
import { FakeProvider } from './fakeProvider.js';

/**
 * Token accounting measured over the seam's projection rather than over raw history.
 *
 * This is the half of checklist item 40 that was deliberately left undone when the sliding window
 * was built, and the reason it was left is the reason this file exists. The compaction triggers
 * and the pre-send hard stop read one number, and that number used to be `visibleTokenEstimate` -
 * the whole visible history. With a window active that is not a cosmetic discrepancy:
 *
 * - compaction would fire on history the window had already stopped sending, spending a provider
 *   call to summarise it and flipping the originals permanently invisible. That destroys exactly
 *   the reversibility that makes a window the thing to *roll back to*;
 * - the hard stop would refuse a request that is in fact small, because it measured history
 *   instead of the request.
 *
 * Both of those are now tested by their control: each test below runs the same scenario twice,
 * once with the component registered and once without, so a regression that ignored the
 * projection would make the two runs identical and fail the test rather than quietly pass it.
 */

// content.length 400 -> estimateTokens() (chars/4) = 100 tokens per entry, 200 per turn.
function padded(label: string): string {
  return `${label} ${'x'.repeat(396)}`.slice(0, 400);
}

function oldTurns(n: number): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(userInputEntry(padded(`old user turn ${i}`)));
    entries.push(aiResponseEntry(padded(`old assistant turn ${i}`)));
  }
  return entries;
}

function answering(times: number): FakeProvider {
  return new FakeProvider(
    Array.from({ length: times }, () => ({
      content: 'answer',
      toolCalls: [],
      stopReason: 'end_turn' as const,
    })),
  );
}

test('compaction does not fire for history a window has already dropped', async () => {
  // 8 turns = 1600 estimated tokens against a 1500 window with 100 reserved: over the line, so
  // the control run must compact.
  const control = answering(2);
  const withoutWindow = new AgentLoop(control, [], 'system');
  withoutWindow.loadEntries(oldTurns(8));
  await withoutWindow.run('new message', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });
  assert.equal(control.callCount, 2, 'control: one summarisation call plus the real turn');

  const provider = answering(1);
  const withWindow = new AgentLoop(provider, [], 'system');
  withWindow.loadEntries(oldTurns(8));
  withWindow.registerCore(slidingWindowComponent({ budgetTokens: 400 }));
  await withWindow.run('new message', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  assert.equal(provider.callCount, 1, 'no summarisation call: the request was never near the line');
  const compactions = withWindow
    .getEntries()
    .filter((e) => e.type === 'ai' && e.sub_type === 'compaction');
  assert.deepEqual(compactions, [], 'and nothing was folded into a summary');
  // The point of a window over compaction: history is untouched, so turning it off restores
  // everything. 16 old entries + the new user message + the answer.
  assert.equal(withWindow.getEntries().filter((e) => e.agent_visible === false).length, 0);
  assert.equal(withWindow.getEntries().length, 18);
});

test('the hard stop measures the request, not the history behind it', async () => {
  // 40 turns = 8000 estimated tokens against a 2000 window, and `keepRecentTokens` set high
  // enough that there is no safe cut point anywhere - so compaction can do nothing at all and the
  // hard stop is the only thing left to decide. That shape matters: the first version of this
  // test let the control compact its way back under the line, which meant it was not testing the
  // hard stop at all.
  const settings = { reserveTokens: 100, keepRecentTokens: 8000 };

  const control = answering(6);
  const withoutWindow = new AgentLoop(control, [], 'system');
  withoutWindow.loadEntries(oldTurns(40));
  const warnings: string[] = [];
  // The refusal is reported as a warning event and the turn returns empty - it is not an answer.
  const refused = await withoutWindow.run('new message', {
    contextWindow: 2000,
    compactionSettings: settings,
    onEvent: (event) => {
      if (event.type === 'warning' && event.text) warnings.push(event.text);
    },
  });
  assert.equal(refused, '', 'control: the turn produced no answer');
  assert.ok(
    warnings.some((w) => /nearly full/.test(w)),
    `control: the hard stop should have refused; warnings were ${JSON.stringify(warnings)}`,
  );
  // It also paid a provider call for a summarisation that did not save it, which is the cost the
  // window exists to avoid. Asserted loosely: what matters is that none of those calls answered.
  assert.ok(control.callCount >= 1, 'control: it tried to compact its way out first');

  const provider = answering(1);
  const withWindow = new AgentLoop(provider, [], 'system');
  withWindow.loadEntries(oldTurns(40));
  withWindow.registerCore(slidingWindowComponent({ budgetTokens: 400 }));
  const answer = await withWindow.run('new message', { contextWindow: 2000, compactionSettings: settings });

  assert.equal(answer, 'answer', 'the window makes this a small request, and it goes out');
  assert.equal(provider.callCount, 1);
});

test('a window shrinking the request does not corrupt the real-usage anchor', async () => {
  // The estimate anchors on the last real `usage.inputTokens` and adds the delta since. Both
  // sides of that subtraction have to describe the same thing: if the anchor were the projected
  // request and the baseline the whole history (or the other way round), the "delta" would be the
  // difference between two unrelated quantities and could easily be negative by thousands.
  const provider = answering(3);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(oldTurns(20));
  loop.registerCore(slidingWindowComponent({ budgetTokens: 400 }));

  for (let i = 0; i < 3; i++) {
    const answer = await loop.run(`message ${i}`, {
      contextWindow: 4000,
      compactionSettings: { reserveTokens: 100, keepRecentTokens: 200 },
    });
    assert.equal(answer, 'answer', `turn ${i} went out`);
  }
  assert.equal(provider.callCount, 3, 'three turns, three calls, no compaction in between');
});

test('with no request hook the accounting is exactly what it was', async () => {
  // The no-op guarantee: every session that registers nothing must behave identically, which is
  // what makes this change safe to land in the most bug-prone function in the codebase.
  const provider = answering(2);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(oldTurns(8));
  assert.equal(loop.getVisibleTokenEstimate(), 1600);

  await loop.run('new message', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });
  assert.equal(provider.callCount, 2, 'it still compacts exactly when it used to');
});

test('one turn runs the request pipeline twice, and not more', async () => {
  // Once for the pre-turn accounting decision and once for the request itself, because the user's
  // own message lands between the two and the second projection therefore describes a different
  // entry list. Pinned because a hook may be expensive - a retrieval component runs a search -
  // and a cache that stopped working would show up here as a climbing number rather than as a
  // slow session nobody could explain.
  const provider = answering(1);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(oldTurns(2));

  let calls = 0;
  loop.registerCore({
    name: 'counter',
    buildRequest: ({ entries }) => {
      calls++;
      return entries;
    },
  });

  await loop.run('hello', { contextWindow: 100_000 });
  assert.equal(calls, 2);
});
