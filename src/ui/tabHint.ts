/**
 * Front-end checklist #11: Tab cycles modes, and until now the only place that said so was the
 * status line's "(/mode or Tab)" - which the plan's own wording calls out as relying on the user
 * reading the status line. The startup banner teaches it instead, and this decides when.
 *
 * Its own module, rather than a few lines inline in cli.ts, because the interesting part is the
 * retirement policy and that is worth testing directly: cli.ts has no test harness, and a tip that
 * either never goes away or never appears is exactly the kind of thing nobody notices until a user
 * complains.
 */

/** How many fresh launches may show the tip before it retires itself. Three is enough to be
 * noticed without becoming scenery - and pressing Tab even once retires it earlier, which is the
 * path this expects most people to take. */
export const TAB_HINT_RUNS = 3;

/** Set once, globally, the first time Tab actually cycles a mode (App.tsx). */
export const TAB_USED_KEY = 'tabUsed';
/** How many fresh launches have shown the tip so far. */
export const TAB_HINT_RUNS_KEY = 'tabHintRuns';

export interface TabHintDecision {
  /** Whether this launch's banner carries the tip. */
  show: boolean;
  /** What to write back to `tabHintRuns`, or `undefined` when this launch should not count. */
  recordRuns?: number;
}

/** A hand-edited or hand-deleted config must not be able to make the tip permanent (a string, or
 * a negative, comparing oddly) or silently suppress it forever (`NaN`, which fails every `<`).
 * Anything that is not a whole count reads as "no runs yet", which errs toward teaching. */
function runsSoFar(raw: unknown): number {
  return Number.isInteger(raw) && (raw as number) >= 0 ? (raw as number) : 0;
}

/**
 * @param config the resolved (merged) config - global/local/personal, as ConfigStore.resolve gives it
 * @param isResume whether this process was launched with `--resume`
 *
 * `isResume` is the part worth keeping straight: the end-of-turn repaint and `/resume` both
 * relaunch the process with that flag, so counting those would spend the whole allowance inside a
 * single session without the user ever seeing a fresh start. A resumed launch still SHOWS the tip
 * if it is owed one - the repaint redraws the banner, and a tip that vanished mid-session for no
 * visible reason would read as a glitch - it just does not consume a run.
 */
export function decideTabHint(config: Record<string, unknown>, isResume: boolean): TabHintDecision {
  if (config[TAB_USED_KEY] === true) return { show: false };
  const runs = runsSoFar(config[TAB_HINT_RUNS_KEY]);
  if (runs >= TAB_HINT_RUNS) return { show: false };
  return { show: true, recordRuns: isResume ? undefined : runs + 1 };
}
