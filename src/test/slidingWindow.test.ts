import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WINDOW_FRACTION,
  slidingWindowComponent,
  windowEntries,
} from '../agent/slidingWindow.js';
import {
  aiResponseEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  estimateTokens,
  userInputEntry,
  type ContextEntry,
} from '../agent/contextEntry.js';
import { AgentLoop } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';

/**
 * The bounded recent window - checklist item 40, built on §5.7's seam.
 *
 * The two things worth testing hard are the two ways a window can produce a request the provider
 * rejects or the model misreads: cutting a tool call away from its result, and sliding past the
 * message that says what the user actually asked for.
 */

/** A turn's worth of entries, with `filler` repeated to make it big. */
function conversation(turns: number, fillerPerTurn = 1): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (let t = 0; t < turns; t++) {
    entries.push(userInputEntry(`request ${t}`));
    for (let f = 0; f < fillerPerTurn; f++) {
      entries.push(aiResponseEntry(`answer ${t}.${f} ${'x'.repeat(400)}`));
    }
  }
  return entries;
}

function totalTokens(entries: readonly ContextEntry[]): number {
  return entries.reduce((sum, e) => sum + estimateTokens(e), 0);
}

// ---------------------------------------------------------------------------------------------
// The window itself
// ---------------------------------------------------------------------------------------------

test('a budget larger than the whole log keeps everything', () => {
  const entries = conversation(3);
  assert.deepEqual(windowEntries(entries, 1_000_000), entries);
});

test('a small budget drops older entries and keeps recent ones', () => {
  const entries = conversation(8);
  const kept = windowEntries(entries, 300);

  assert.ok(kept.length < entries.length, 'something must have been dropped');
  // The most recent entry is always in.
  assert.equal(kept[kept.length - 1], entries[entries.length - 1]);
  assert.ok(totalTokens(kept) < totalTokens(entries));
});

test('history is never mutated - the window only chooses what to send', () => {
  // The invariant that makes this "rollback-able": turning the window off restores everything,
  // because it never changed anything. Compaction, by contrast, is one-way.
  const entries = conversation(8);
  const before = [...entries];
  const beforeVisibility = entries.map((e) => e.agent_visible);

  windowEntries(entries, 200);

  assert.deepEqual(entries, before, 'the input array must be untouched');
  assert.deepEqual(
    entries.map((e) => e.agent_visible),
    beforeVisibility,
    'no entry may be flipped to hidden - that is compaction\'s job, not this',
  );
});

test('the first user message is always kept, even when the window slid past it', () => {
  // It is the task statement. A window that dropped it would leave the model working on a goal it
  // can no longer see - the same reason AgentLoop pins this entry for compaction.
  const entries = conversation(10);
  const kept = windowEntries(entries, 200);

  const first = entries[0];
  assert.equal(first.sub_type, 'input');
  assert.ok(kept.includes(first), 'the first user input must survive any window size');
  assert.equal(kept[0], first, 'and it belongs at the front, where it was');
});

test('the first user message is not duplicated when it was already inside the window', () => {
  const entries = conversation(2);
  const kept = windowEntries(entries, 50);
  const firstCount = kept.filter((e) => e.id === entries[0].id).length;
  assert.equal(firstCount, 1, `the pinned entry appears ${firstCount} times`);
});

test('a tool call is never separated from its result', () => {
  // The failure a naive slice(-n) produces: an orphaned toolcall is a malformed conversation, and
  // providers reject it. findCutPoint is reused rather than reimplemented precisely for this.
  const entries: ContextEntry[] = [userInputEntry('do the thing')];
  for (let i = 0; i < 12; i++) {
    const call = { id: `call${i}`, name: 'grep', input: { q: `${i}` } };
    entries.push(aiToolCallEntry(call, false));
    entries.push(aiToolCallResponseEntry(call.id, `result ${i} ${'y'.repeat(300)}`, false));
  }

  for (const budget of [50, 120, 300, 700, 1500]) {
    const kept = windowEntries(entries, budget);
    const callIds = kept.filter((e) => e.sub_type === 'toolcall').map((e) => e.tool_call_id);
    const resultIds = new Set(
      kept.filter((e) => e.sub_type === 'toolcallresponse').map((e) => e.tool_call_id),
    );
    for (const id of callIds) {
      assert.ok(resultIds.has(id), `budget ${budget}: call ${id} kept without its result`);
    }
  }
});

test('an empty log and a zero budget are both no-ops rather than errors', () => {
  assert.deepEqual(windowEntries([], 100), []);
  const entries = conversation(3);
  assert.deepEqual(windowEntries(entries, 0), entries);
  assert.deepEqual(windowEntries(entries, -5), entries);
});

// ---------------------------------------------------------------------------------------------
// As a core component
// ---------------------------------------------------------------------------------------------

test('the component does nothing when the context window is unknown and no budget is set', () => {
  // "Never guess the window" - the same rule compaction and the status bar follow. A component
  // that existed must never make a session worse than not having it.
  const component = slidingWindowComponent();
  const entries = conversation(10);
  assert.deepEqual(component.buildRequest!({ entries }), entries);
});

test('the component derives its budget from the context window', () => {
  const component = slidingWindowComponent();
  const entries = conversation(12);
  const windowed = component.buildRequest!({ entries, contextWindow: 400 });
  assert.ok(Array.isArray(windowed));
  assert.ok(windowed.length < entries.length, 'a 400-token window over this log must drop entries');
  // Half of 400 by default, so the kept set should be well under the whole thing.
  assert.ok(totalTokens(windowed) < totalTokens(entries));
  assert.equal(DEFAULT_WINDOW_FRACTION, 0.5);
});

test('an explicit budget overrides the context-window fraction', () => {
  const entries = conversation(12);
  const tight = slidingWindowComponent({ budgetTokens: 60 }).buildRequest!({
    entries,
    contextWindow: 1_000_000,
  });
  // The explicit budget wins, so a huge context window does not make this keep everything.
  assert.ok((tight as readonly ContextEntry[]).length < entries.length);
});

test('a custom fraction is honoured', () => {
  const entries = conversation(12);
  const half = slidingWindowComponent({ fraction: 0.5 }).buildRequest!({ entries, contextWindow: 800 });
  const tiny = slidingWindowComponent({ fraction: 0.05 }).buildRequest!({ entries, contextWindow: 800 });
  assert.ok(
    (tiny as readonly ContextEntry[]).length <= (half as readonly ContextEntry[]).length,
    'a smaller fraction must not keep more',
  );
});

test('registered on a real loop, it bounds what the provider is sent', async () => {
  // End to end through AgentLoop, not just the pure function: the seam has to actually carry it.
  const provider = new FakeProvider([{ content: 'done', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  // Seed a long history the way /resume would.
  loop.loadEntries(conversation(10));
  loop.registerCore(slidingWindowComponent({ budgetTokens: 80 }));

  await loop.run('the newest question', { contextWindow: 100_000 });

  const sent = provider.receivedRequests[0].messages;
  const text = JSON.stringify(sent);
  assert.ok(text.includes('the newest question'), 'the current turn must always be sent');
  assert.ok(text.includes('request 0'), 'the pinned first user message must be sent');
  assert.ok(!text.includes('answer 4.0'), 'a mid-history entry outside the window must not be sent');
  // And history itself still has everything.
  assert.ok(loop.getEntries().length > sent.length, 'history keeps what the window did not send');
});
