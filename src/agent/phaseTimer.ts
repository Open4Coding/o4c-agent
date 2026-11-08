/**
 * Where a turn's time went: reading the prompt (prefill), thinking, and answering. Shown on the
 * footer's third line so a slow turn can be told apart at a glance - a long prompt to read, a long
 * think, or a long answer are three different problems with three different fixes.
 *
 * Prefill is the server's own figure (`timings.prompt_ms`) when it sends one; until then, and for
 * a provider that never does, it is the wait for the first token, which also holds network time
 * and any queueing behind another request. Thinking and answering are timed here, from the stream:
 * the server reports one generation time for both, and only the client sees where one stops and
 * the other starts.
 */

export interface PhaseTimes {
  prefillMs: number;
  thinkMs: number;
  answerMs: number;
}

export function zeroPhases(): PhaseTimes {
  return { prefillMs: 0, thinkMs: 0, answerMs: 0 };
}

export function addPhases(a: PhaseTimes, b: PhaseTimes): PhaseTimes {
  return { prefillMs: a.prefillMs + b.prefillMs, thinkMs: a.thinkMs + b.thinkMs, answerMs: a.answerMs + b.answerMs };
}

/** One request's phases, fed as its stream arrives. */
export class RequestPhases {
  private firstOutput?: number;
  private firstThink?: number;
  private lastThink?: number;
  /** The first output after thinking began that is not thinking: where the answer starts. */
  private thinkEnd?: number;
  private ended?: number;
  private serverPrefillMs?: number;

  constructor(private readonly startedAt: number) {}

  /** Streamed text, by kind. A tool call being written counts as answer (`'text'`). */
  output(kind: 'think' | 'text', at: number): void {
    if (this.ended !== undefined) return;
    this.firstOutput ??= at;
    if (kind === 'think') {
      this.firstThink ??= at;
      this.lastThink = at;
    } else if (this.firstThink !== undefined) {
      this.thinkEnd ??= at;
    }
  }

  end(at: number, serverPrefillMs?: number): void {
    if (this.ended !== undefined) return;
    this.ended = at;
    this.serverPrefillMs = serverPrefillMs;
  }

  /** The phases so far; `now` is used only while the request is still running. */
  times(now: number): PhaseTimes {
    const end = this.ended ?? now;
    const waited = Math.max(0, (this.firstOutput ?? end) - this.startedAt);
    const prefillMs = this.serverPrefillMs ?? waited;
    if (this.firstOutput === undefined) return { prefillMs, thinkMs: 0, answerMs: 0 };
    if (this.firstThink === undefined) return { prefillMs, thinkMs: 0, answerMs: Math.max(0, end - this.firstOutput) };
    // Still thinking (nothing else has come since), or ended on a think with nothing after it.
    const thinkEnd = this.thinkEnd ?? (this.ended !== undefined ? this.lastThink! : now);
    return {
      prefillMs,
      thinkMs: Math.max(0, thinkEnd - this.firstThink),
      // Any answer text before the thinking began is answer time too.
      answerMs: Math.max(0, end - thinkEnd) + Math.max(0, this.firstThink - this.firstOutput),
    };
  }
}

/** `prefill 4.2s · think 38.0s · answer 6.1s`, with minutes once a phase passes 60 s. */
export function formatPhases(t: PhaseTimes): string {
  const f = (ms: number) => {
    if (ms < 59950) return `${(ms / 1000).toFixed(1)}s`;
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  };
  return `prefill ${f(t.prefillMs)} · think ${f(t.thinkMs)} · answer ${f(t.answerMs)}`;
}
