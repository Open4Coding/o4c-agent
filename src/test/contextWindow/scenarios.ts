import assert from 'node:assert/strict';
import type { ScenarioResult, ScenarioSpec, TurnSpec } from './harness.js';
import type { ScriptRound, SummarizerMode } from './scriptedProvider.js';

export const DEFAULT_WINDOWS = [4096, 8192, 16384, 32768, 57344, 114688, 229376];

const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const tokensOf = (window: number, fraction: number): number => Math.max(1, Math.round(fraction * window));

/** Small deterministic PRNG (mulberry32), so a seed reproduces the same rounds. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mixedTurns(window: number, seed: number): TurnSpec[] {
  const rng = mulberry32(seed);
  const upTo = (fraction: number): number => Math.floor(rng() * fraction * window);
  const turns: TurnSpec[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const rounds: ScriptRound[] = many(10, () => {
      const calls = rng() < 0.5 ? [] : many(1 + Math.floor(rng() * 2), () => ({
        argTokens: upTo(0.03),
        resultTokens: upTo(0.04),
      }));
      const round: ScriptRound = {
        thinkTokens: rng() < 0.4 ? 0 : upTo(0.05),
        responseTokens: Math.max(1, upTo(0.02)),
        calls,
      };
      return round;
    });
    rounds.push({ responseTokens: 30 });
    turns.push({ prompt: `mixed turn ${turn}`, rounds });
  }
  return turns;
}

function toolHeavyTurns(window: number, rounds: number): TurnSpec[] {
  const argTokens = tokensOf(window, 0.02);
  const resultTokens = tokensOf(window, 0.02);
  return [
    {
      prompt: 'refactor the module',
      rounds: [...many(rounds, () => ({ calls: [{ argTokens, resultTokens }] })), { responseTokens: 20 }],
    },
  ];
}

/** Long prose turns with no tool calls: pruning cannot free them, so tier 3 (the summarizer) must fire. */
function summarizerScenario(mode: SummarizerMode): ScenarioSpec {
  return {
    name: `summarizer-${mode}`,
    summarizer: mode,
    build: (window) =>
      many(12, (i) => ({
        prompt: `task ${i}`,
        rounds: [{ responseTokens: tokensOf(window, 0.08) }],
      })),
    check: (r) => {
      if (r.window >= 57344) {
        assert.ok(r.stats.summarizerCalls >= 1, 'tier 3 should call the summarizer at this window');
      }
    },
  };
}

/**
 * A long session: `turns` user turns of `roundsPerTurn` mixed rounds each (think, response, tool calls),
 * so the window fills over hundreds of entries and every tier of context management gets exercised.
 */
export function longRunTurns(window: number, turns: number, roundsPerTurn: number, seed: number): TurnSpec[] {
  const rng = mulberry32(seed);
  const upTo = (fraction: number): number => Math.floor(rng() * fraction * window);
  return many(turns, (t) => ({
    prompt: `long task ${t}`,
    rounds: [
      ...many(roundsPerTurn, () => ({
        thinkTokens: rng() < 0.5 ? upTo(0.01) : 0,
        responseTokens: Math.max(1, upTo(0.005)),
        // Every round but the last calls a tool: a round without one ends the turn, as in the real loop.
        calls: many(1 + Math.floor(rng() * 2), () => ({ argTokens: upTo(0.008), resultTokens: upTo(0.012) })),
      })),
      { responseTokens: 20 },
    ],
  }));
}

/** Checks the order the tiers fire in across a long run: prune first, then compaction, hard-stop last. */
function checkTierOrder(r: ScenarioResult): void {
  if (r.window < 57344) return;
  const firstPrune = r.timeline.find((e) => e.kind === 'prune')?.at;
  const firstCompact = r.timeline.find((e) => e.kind === 'compaction')?.at;
  const firstStop = r.timeline.find((e) => e.kind === 'hard-stop')?.at;
  assert.ok(r.prunes >= 1, 'pruning should fire during a long run at this window');
  if (firstCompact !== undefined && firstPrune !== undefined) {
    assert.ok(firstPrune <= firstCompact, `prune (request ${firstPrune}) should come before compaction (${firstCompact})`);
  }
  if (firstStop !== undefined) {
    assert.ok(
      firstCompact !== undefined && firstStop > firstCompact,
      `hard-stop (request ${firstStop}) should only happen after compaction (${firstCompact ?? 'never'})`,
    );
  }
}

export const SCENARIOS: ScenarioSpec[] = [
  {
    name: 'long-run-steady',
    build: (window) => longRunTurns(window, 8, 25, 21),
    check: checkTierOrder,
  },
  {
    name: 'soak-long-session',
    windows: [65536, 114688, 229376],
    build: (window) => longRunTurns(window, 30, 50, 31),
    check: checkTierOrder,
  },
  {
    name: 'long-run-code-heavy',
    drift: 1.5,
    build: (window) => longRunTurns(window, 8, 25, 22),
    check: checkTierOrder,
  },
  {
    name: 'cutoff-chain',
    build: () => [
      {
        prompt: 'think at length',
        rounds: [...many(12, () => ({ thinkTokens: 'overflow' as const })), { responseTokens: 20 }],
      },
    ],
    check: (r) => {
      assert.equal(r.requests, 13, 'every cutoff should auto-continue into the next request');
      assert.equal(r.prunes, 11, 'each cutoff round should hide the one before it');
    },
  },
  {
    name: 'cutoff-superseded-by-tool',
    build: (window) => [
      {
        prompt: 'think, then act',
        rounds: [
          ...many(3, () => ({ thinkTokens: 'overflow' as const })),
          { calls: [{ argTokens: tokensOf(window, 0.01), resultTokens: tokensOf(window, 0.01) }] },
          { responseTokens: 20 },
        ],
      },
    ],
    check: (r) => {
      assert.equal(r.requests, 5, 'expected 3 cutoffs, one tool round, one final answer');
      assert.equal(r.prunes, 3, 'the last cutoff must be hidden by the tool round too');
    },
  },
  {
    name: 'tool-heavy-single-turn',
    build: (window) => toolHeavyTurns(window, 60),
  },
  {
    name: 'tool-heavy-tier3',
    build: (window) => [
      {
        prompt: 'long tool chain with real reasoning',
        rounds: [
          ...many(40, () => ({
            thinkTokens: tokensOf(window, 0.03),
            calls: [{ argTokens: tokensOf(window, 0.01), resultTokens: tokensOf(window, 0.01) }],
          })),
          { responseTokens: 20 },
        ],
      },
    ],
    check: (r) => {
      if (r.window >= 57344) {
        assert.ok(r.compactions >= 1, 'tier 3 should fire inside a single tool-heavy turn');
      }
    },
  },
  {
    name: 'think-only-end',
    build: () => [{ prompt: 'reason, then stop', rounds: [{ thinkTokens: 50 }] }],
  },
  {
    name: 'mixed-rounds',
    build: (window) => mixedTurns(window, 7),
  },
  {
    name: 'truncated-tool-call',
    build: (window) => {
      const call = { argTokens: tokensOf(window, 0.01), resultTokens: tokensOf(window, 0.01) };
      return [
        {
          prompt: 'write files',
          rounds: [
            { calls: [call] },
            { truncatedToolCall: true, responseTokens: 30 },
            { calls: [call] },
            { responseTokens: 30 },
          ],
        },
      ];
    },
    check: (r) => {
      assert.ok(
        r.turns[0]?.warnings.some((w) => w.includes('cut off')),
        'expected the cut-off warning for the truncated tool call',
      );
      assert.equal(r.requests, 4, 'a truncated tool call should be continued, not end the turn');
    },
  },
  {
    name: 'mid-sentence-end',
    build: (window) => [
      {
        prompt: 'read then answer',
        rounds: [
          { calls: [{ argTokens: tokensOf(window, 0.01), resultTokens: tokensOf(window, 0.01) }] },
          { responseTokens: 30, endMidSentence: true },
          { responseTokens: 20 },
        ],
      },
    ],
    check: (r) => {
      const nudges = r.events.filter((e) => e.type === 'warning' && (e.text ?? '').includes('mid-reply')).length;
      assert.equal(nudges, 1, 'expected exactly one nudge for the mid-sentence stop');
      assert.equal(r.turns[0]?.outcome, 'text', 'turn should recover and finish');
    },
  },
  summarizerScenario('ok'),
  summarizerScenario('throw'),
  summarizerScenario('garbage'),
  summarizerScenario('huge'),
  {
    name: 'resume-over-limit',
    preload: (window) => ({ pairs: 26, tokensEach: tokensOf(window, 0.025) }),
    build: () => [{ prompt: 'continue', rounds: [{ responseTokens: 30 }] }],
    check: (r) => {
      assert.ok(r.compactions + r.hardStops >= 1, 'an over-limit resume should compact or hard-stop');
    },
  },
  {
    name: 'abort-then-continue',
    build: (window) => {
      const call = { argTokens: tokensOf(window, 0.01), resultTokens: tokensOf(window, 0.01) };
      return [
        {
          prompt: 'abort-me',
          abortable: true,
          rounds: [{ calls: [call] }, { calls: [call], abortDuring: true }, { responseTokens: 20 }],
        },
        { prompt: 'carry on', rounds: [{ calls: [call] }, { responseTokens: 20 }] },
      ];
    },
    check: (r) => {
      assert.equal(r.turns[0]?.outcome, 'aborted');
      assert.equal(r.turns[1]?.outcome, 'text');
      assert.ok(
        !r.finalEntries.some((e) => e.content === 'abort-me'),
        'the aborted prompt must be rolled back out of history',
      );
    },
  },
  {
    name: 'tool-heavy-drift-1.5',
    drift: 1.5,
    build: (window) => toolHeavyTurns(window, 60),
  },
  {
    name: 'mixed-drift-0.9',
    drift: 0.9,
    build: (window) => mixedTurns(window, 11),
  },
  {
    name: 'overhead-heavy',
    windows: [4096, 8192],
    systemPromptTokens: (window) => Math.round(0.2 * window),
    extraTools: 15,
    build: (window) => toolHeavyTurns(window, 30),
  },
  {
    // The 2026-10-06 failure, as a scenario: `run_shell` returned one `dir /s /b` result of
    // 11,370,857 chars - about 15x a 229,376-token window - in a single toolcallresponse, and the
    // session was dead on the second tool call. Nothing downstream of the append can recover from a
    // single entry larger than the whole window (pruning freed 29 tokens against it in the real
    // run), so the result itself has to be bounded: see `tools/toolOutput.ts`. Checked at every
    // window, because the budget is window-derived. 3x the window is already far past any budget;
    // the full 11 MB fixture lives in `toolOutput.test.ts`, which doesn't pay for it seven times.
    name: 'giant-tool-result',
    build: (window) => [
      {
        prompt: 'list the whole tree',
        rounds: [
          { calls: [{ argTokens: 20, resultTokens: window * 3 }] },
          { calls: [{ argTokens: 20, resultTokens: window * 3 }] },
          { responseTokens: 20 },
        ],
      },
    ],
    check: (r) => {
      assert.equal(r.hardStops, 0, 'a bounded tool result must not wedge the session');
      assert.equal(r.turns[0]?.outcome, 'text', 'the turn still reaches a final answer');
      const biggest = Math.max(...r.finalEntries.map((e) => e.content.length));
      assert.ok(biggest <= 40_000, `largest entry was ${biggest} chars`);
    },
  },
  {
    // Reproduces the real 2026-10-07 failure in miniature: ONE user turn whose context is filled by
    // the model's own prose and reasoning (which pruning structurally cannot free - it only takes
    // `toolcall`/`toolcallresponse` pairs), punctuated by tool calls with near-empty results, which
    // exist only to give `findCutPoint()` the safe cut points a single long turn would otherwise
    // lack. That drives tier 3 round after round, and before the pin the twelfth or thirteenth pass
    // swept the prompt itself into `slice(0, cutPoint)` and released it - the model lost its own task
    // and the session never recovered. The `task-prompt-stays-visible` / `task-prompt-stays-intact`
    // invariants assert this for every scenario; this one exists to guarantee the condition is
    // actually *reached*, which no other scenario does.
    name: 'repeated-compaction-keeps-task-prompt',
    summarizer: 'ok',
    build: (window) => [
      {
        prompt: `TASK-MATRIX-SENTINEL cover all 30 subsystems in order. ${'detail '.repeat(40)}`,
        rounds: [
          ...many(45, () => ({
            thinkTokens: tokensOf(window, 0.06),
            responseTokens: tokensOf(window, 0.05),
            // A near-empty result: prune can take the pair but frees almost nothing, exactly as the
            // real `echo <id> done >> progress.txt` rounds did.
            calls: [{ argTokens: 8, resultTokens: 2 }],
          })),
          { responseTokens: 20 },
        ],
      },
    ],
    check: (r) => {
      // Small windows can hard-stop on prose alone; the pin is what's under test, not the budget.
      if (r.window >= 57344) {
        assert.ok(r.compactions >= 2, `expected repeated compaction, got ${r.compactions}`);
      }
      const prompt = r.finalEntries.find((e) => e.type === 'user' && e.sub_type === 'input');
      assert.ok(prompt, 'the task prompt entry must still exist');
      assert.notEqual(prompt.agent_visible, false, 'the task prompt must never be hidden from the model');
      assert.ok(
        prompt.content.includes('TASK-MATRIX-SENTINEL'),
        `the task prompt must stay intact, got ${JSON.stringify(prompt.content.slice(0, 80))}`,
      );
    },
  },
];
