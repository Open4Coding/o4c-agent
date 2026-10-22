import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoop } from '../agent/loop.js';
import { userInputEntry, aiResponseEntry, type ContextEntry } from '../agent/contextEntry.js';
import { MIN_WINDOW_TOKENS, describeWindowSetting, parseWindowSetting } from '../ui/windowSetting.js';
import { FakeProvider } from './fakeProvider.js';

/**
 * The `/window` switch - checklist item 40's second half.
 *
 * Two things are worth pinning. The argument parsing, because `/window 50` and `/window 0.5` mean
 * very different things and a misread would silently send a tiny fraction of the conversation.
 * And the switch itself: it has to be reversible *in the same session*, since the whole claim
 * this feature makes over compaction is that turning it off restores everything immediately.
 */

test('a token count, a k suffix and a percentage all parse', () => {
  assert.deepEqual(parseWindowSetting('40000'), { budgetTokens: 40000 });
  assert.deepEqual(parseWindowSetting('40k'), { budgetTokens: 40000 });
  assert.deepEqual(parseWindowSetting('  40 K '), { budgetTokens: 40000 });
  assert.deepEqual(parseWindowSetting('50%'), { fraction: 0.5 });
  assert.deepEqual(parseWindowSetting('12.5%'), { fraction: 0.125 });
});

test('a bare number under one is a fraction, and above it a token count', () => {
  // `/window 0.5` can only sensibly mean half, and `/window 40000` can only mean tokens; the two
  // ranges do not overlap, so neither reading is ambiguous.
  assert.deepEqual(parseWindowSetting('0.5'), { fraction: 0.5 });
  assert.deepEqual(parseWindowSetting('0.25'), { fraction: 0.25 });
  assert.deepEqual(parseWindowSetting('2000'), { budgetTokens: 2000 });
});

test('nonsense and uselessly small windows are refused rather than honoured', () => {
  assert.equal(parseWindowSetting(''), undefined);
  assert.equal(parseWindowSetting('off'), undefined, 'handled by the command, not by the parser');
  assert.equal(parseWindowSetting('lots'), undefined);
  assert.equal(parseWindowSetting('40 000'), undefined);
  assert.equal(parseWindowSetting('150%'), undefined, 'more than the whole window is not a window');
  assert.equal(parseWindowSetting('0%'), undefined);
  // A budget too small to hold one exchange would make every request useless; refusing says so
  // instead of silently sending almost nothing.
  assert.equal(parseWindowSetting(String(MIN_WINDOW_TOKENS - 1)), undefined);
  assert.deepEqual(parseWindowSetting(String(MIN_WINDOW_TOKENS)), { budgetTokens: MIN_WINDOW_TOKENS });
});

test('a setting reads back in the terms it was given in', () => {
  assert.equal(describeWindowSetting({ budgetTokens: 40000 }), '40,000 tokens');
  assert.equal(describeWindowSetting({ fraction: 0.5 }), '50% of the context window');
  assert.equal(describeWindowSetting({}), '50% of the context window', 'the default fraction');
});

// ------------------------------------------------------------------ the switch

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

function recording(): { provider: FakeProvider; sent: number[] } {
  const sent: number[] = [];
  const provider = new FakeProvider(
    Array.from({ length: 6 }, () => ({ content: 'answer', toolCalls: [], stopReason: 'end_turn' as const })),
  );
  const complete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    sent.push(request.messages.length);
    return complete(request);
  };
  return { provider, sent };
}

test('the window can be turned on and off inside one session', async () => {
  const { provider, sent } = recording();
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(oldTurns(10)); // 20 entries, 2000 estimated tokens

  assert.equal(loop.slidingWindowSettings(), undefined, 'off by default');
  await loop.run('first', { contextWindow: 100_000 });
  const withoutWindow = sent[0];

  loop.setSlidingWindow({ budgetTokens: 400 });
  assert.deepEqual(loop.slidingWindowSettings(), { budgetTokens: 400 });
  await loop.run('second', { contextWindow: 100_000 });
  const withWindow = sent[1];
  assert.ok(withWindow < withoutWindow, `window should shrink the request: ${withWindow} vs ${withoutWindow}`);

  // The claim that makes this a rollback rather than an operation: nothing was destroyed, so
  // turning it off restores the whole conversation on the very next request.
  loop.setSlidingWindow(undefined);
  assert.equal(loop.slidingWindowSettings(), undefined);
  await loop.run('third', { contextWindow: 100_000 });
  assert.ok(sent[2] > withWindow, 'the full context is back');
  assert.equal(loop.getEntries().filter((e) => e.agent_visible === false).length, 0, 'and nothing was hidden');
});

test('turning the window off when it was never on registers nothing', () => {
  const loop = new AgentLoop(new FakeProvider([]), [], 'system');
  loop.setSlidingWindow(undefined);
  // The component is registered on first *use*, so that a session which never asks for a window
  // keeps the fast path where the request pipeline is skipped entirely.
  assert.deepEqual(loop.coreComponentNames(), []);

  loop.setSlidingWindow({ fraction: 0.5 });
  assert.deepEqual(loop.coreComponentNames(), ['sliding-window']);
  loop.setSlidingWindow(undefined);
  assert.deepEqual(loop.coreComponentNames(), ['sliding-window'], 'it stays registered, and inert');
});
