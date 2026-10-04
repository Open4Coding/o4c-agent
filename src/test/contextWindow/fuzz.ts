import { runScenario, type ScenarioResult, type ScenarioSpec, type TurnSpec } from './harness.js';
import type { ScriptRound, SummarizerMode } from './scriptedProvider.js';
import { mulberry32 } from './scenarios.js';

/** A plain-data case: JSON round-trips, so a failing case can be saved, replayed and shrunk. */
export interface FuzzCase {
  seed: number;
  window: number;
  drift: number;
  summarizer: SummarizerMode;
  preload?: { pairs: number; tokensEach: number };
  turns: Array<{ prompt: string; abortable: boolean; rounds: ScriptRound[] }>;
}

// Measured against the live server: prose ~0.76 of chars/4, code-heavy text ~1.89.
const DRIFTS = [0.75, 1, 1.5, 1.9];
const SUMMARIZERS: SummarizerMode[] = ['ok', 'throw', 'garbage', 'huge'];
const TOOLS = ['read_file', 'write_file'];

/** Same seed and window always give the same case. Token sizes are fractions of the window. */
export function generateCase(seed: number, window: number): FuzzCase {
  const rng = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
  const chance = (p: number): boolean => rng() < p;
  const upTo = (fraction: number): number => Math.floor(rng() * fraction * window);

  const genRound = (abortable: boolean): ScriptRound => {
    const round: ScriptRound = {};
    if (chance(0.1)) round.thinkTokens = 'overflow';
    else if (chance(0.5)) round.thinkTokens = upTo(0.05);
    if (chance(0.7)) round.responseTokens = upTo(0.03);
    if (chance(0.1)) round.endMidSentence = true;
    if (chance(0.5)) {
      round.calls = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => ({
        argTokens: upTo(0.03),
        resultTokens: upTo(0.04),
        tool: pick(TOOLS),
      }));
    }
    if (chance(0.05)) round.truncatedToolCall = true;
    if (abortable && chance(0.05)) round.abortDuring = true;
    return round;
  };

  const turnCount = 1 + Math.floor(rng() * 4);
  const turns = Array.from({ length: turnCount }, (_, t) => {
    const abortable = chance(0.15);
    const roundCount = 1 + Math.floor(rng() * 30);
    return {
      prompt: `fuzz turn ${t}`,
      abortable,
      rounds: Array.from({ length: roundCount }, () => genRound(abortable)),
    };
  });

  const testCase: FuzzCase = {
    seed,
    window,
    drift: pick(DRIFTS),
    summarizer: pick(SUMMARIZERS),
    turns,
  };
  if (chance(0.15)) {
    testCase.preload = { pairs: 1 + Math.floor(rng() * 20), tokensEach: Math.max(1, upTo(0.03)) };
  }
  return testCase;
}

function caseToSpec(c: FuzzCase): ScenarioSpec {
  const turns: TurnSpec[] = c.turns.map((t) => ({ prompt: t.prompt, abortable: t.abortable, rounds: t.rounds }));
  return {
    name: `fuzz-${c.seed}`,
    drift: c.drift,
    summarizer: c.summarizer,
    preload: c.preload ? () => c.preload! : undefined,
    build: () => turns,
  };
}

export function runCase(c: FuzzCase): Promise<ScenarioResult> {
  return runScenario(caseToSpec(c), c.window);
}

/** The first invariant a case breaks, or undefined if it passes. */
export async function firstViolation(c: FuzzCase): Promise<string | undefined> {
  return (await runCase(c)).violations[0]?.invariant;
}

const TOKEN_FIELDS = ['thinkTokens', 'responseTokens'] as const;

/** Strictly decreases with every shrink step, so shrinking always terminates. */
export function caseSize(c: FuzzCase): number {
  let size = c.turns.length + (c.drift !== 1 ? 1 : 0) + (c.summarizer !== 'ok' ? 1 : 0);
  if (c.preload) size += 1 + c.preload.pairs + c.preload.tokensEach;
  for (const turn of c.turns) {
    size += turn.abortable ? 1 : 0;
    size += turn.rounds.length;
    for (const round of turn.rounds) {
      size += round.thinkTokens === 'overflow' ? 1000 : round.thinkTokens ?? 0;
      size += round.responseTokens ?? 0;
      size += round.endMidSentence || round.truncatedToolCall || round.abortDuring ? 1 : 0;
      for (const call of round.calls ?? []) size += 1 + call.argTokens + call.resultTokens;
    }
  }
  return size;
}

/** Every one-step simplification of `c`. Each candidate is a fresh deep copy. */
function* candidates(c: FuzzCase): Generator<FuzzCase> {
  const copy = (): FuzzCase => structuredClone(c);

  for (let t = 0; t < c.turns.length && c.turns.length > 1; t++) {
    const next = copy();
    next.turns.splice(t, 1);
    yield next;
  }

  if (c.preload) {
    const next = copy();
    delete next.preload;
    yield next;
  }

  for (let t = 0; t < c.turns.length; t++) {
    const roundCount = c.turns[t].rounds.length;
    for (let chunk = Math.max(1, roundCount >> 1); chunk >= 1; chunk >>= 1) {
      for (let start = 0; start + chunk <= roundCount; start += chunk) {
        const next = copy();
        next.turns[t].rounds.splice(start, chunk);
        if (next.turns[t].rounds.length > 0) yield next;
      }
    }
  }

  for (let t = 0; t < c.turns.length; t++) {
    for (let r = 0; r < c.turns[t].rounds.length; r++) {
      const round = c.turns[t].rounds[r];
      if (round.calls?.length) {
        const next = copy();
        delete next.turns[t].rounds[r].calls;
        yield next;
      }
      for (const flag of ['endMidSentence', 'truncatedToolCall', 'abortDuring'] as const) {
        if (round[flag]) {
          const next = copy();
          delete next.turns[t].rounds[r][flag];
          yield next;
        }
      }
      if (round.thinkTokens === 'overflow') {
        const next = copy();
        next.turns[t].rounds[r].thinkTokens = 0;
        yield next;
      }
      for (const field of TOKEN_FIELDS) {
        const value = round[field];
        if (typeof value === 'number' && value > 0) {
          const next = copy();
          next.turns[t].rounds[r][field] = Math.floor(value / 2);
          yield next;
        }
      }
      for (let k = 0; k < (round.calls?.length ?? 0); k++) {
        const call = round.calls![k];
        if (call.argTokens > 0 || call.resultTokens > 0) {
          const next = copy();
          next.turns[t].rounds[r].calls![k].argTokens = Math.floor(call.argTokens / 2);
          next.turns[t].rounds[r].calls![k].resultTokens = Math.floor(call.resultTokens / 2);
          yield next;
        }
      }
    }
  }

  if (c.drift !== 1) {
    const next = copy();
    next.drift = 1;
    yield next;
  }
  if (c.summarizer !== 'ok') {
    const next = copy();
    next.summarizer = 'ok';
    yield next;
  }
}

/**
 * Greedy shrink: take the first one-step simplification that still fails, and repeat until none does.
 * `fails` decides what counts as failing, so a bug can be shrunk while keeping the same invariant.
 */
export async function shrink(
  start: FuzzCase,
  fails: (c: FuzzCase) => boolean | Promise<boolean>,
): Promise<FuzzCase> {
  let current = start;
  let improved = true;
  while (improved) {
    improved = false;
    for (const candidate of candidates(current)) {
      if (caseSize(candidate) >= caseSize(current)) continue;
      if (await fails(candidate)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}
