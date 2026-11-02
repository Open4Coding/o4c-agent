import { findCutPoint } from './compaction.js';
import { estimateTokens, type ContextEntry } from './contextEntry.js';
import type { CoreComponent, RequestBuild } from './coreSeam.js';

/**
 * A bounded recent window over history, as a core-tier component - checklist item 40, design doc
 * §2.4 and §5.7.
 *
 * **How this differs from §2.3's compaction, which is the whole reason it exists.** Compaction
 * also keeps a recent window, but it pays for the old part: it makes an LLM call to summarize it,
 * appends the summary, and flips the originals `agent_visible = false` **permanently**. This does
 * none of that. It simply does not *send* the old part this turn - no provider call, no summary
 * entry, nothing mutated, and nothing lost: history is untouched and the very next request can
 * include all of it again.
 *
 * That makes it the thing to roll back **to**:
 *
 * - It is free and instant where compaction costs a round-trip and a wait.
 * - It is deterministic. Compaction's output is model-generated, and this project has already
 *   fixed six separate compaction bugs (checklist item 5) whose common shape was a summary doing
 *   something unexpected. A window has no such failure mode.
 * - It is reversible. Compaction is one-way - once detail is folded into a summary and the
 *   originals are hidden, the originals are only recoverable from the logs on disk. Turning this
 *   off restores the full context immediately, because it never changed anything.
 *
 * The cost is the honest one: the model does not see the older material at all, not even in
 * summary. That is a worse default and a better escape hatch, which is why it is off unless asked
 * for.
 */

/** The fraction of the context window the window defaults to when no explicit budget is given. */
export const DEFAULT_WINDOW_FRACTION = 0.5;

/**
 * Where a new cut lands, as a fraction of the budget (plan 0006 A10). The window used to re-cut on
 * every request, so once over budget the cut crept forward a little each round and the server
 * re-processed nearly the whole window every round (Qwen3.8 reuses only an exact prefix). Now a cut
 * is kept until the window outgrows the budget again, then moved down to this share of it - one
 * re-process per 25% of growth instead of one per round.
 */
export const WINDOW_HYSTERESIS = 0.75;

export interface SlidingWindowOptions {
  /**
   * An explicit budget in tokens. Omitted, the budget is `DEFAULT_WINDOW_FRACTION` of the run's
   * `contextWindow`, and if that is unknown too the component does nothing at all - the same
   * "never guess the window" rule compaction and the status bar already follow.
   */
  readonly budgetTokens?: number;
  /** Overrides the fraction used when `budgetTokens` is not set. */
  readonly fraction?: number;
  /** Overrides `WINDOW_HYSTERESIS` (config `windowHysteresis`); 1 = re-cut every request. */
  readonly hysteresis?: number;
}

/** The first `user`/`input` entry - the original task statement. */
function firstUserInput(entries: readonly ContextEntry[]): ContextEntry | undefined {
  return entries.find((e) => e.type === 'user' && e.sub_type === 'input');
}

/**
 * Chooses the entries to send. Pure and exported so the policy is assertable without a loop.
 *
 * Two things it is careful about, both of which would otherwise produce a request the provider
 * rejects or the model misreads:
 *
 * - **It cuts only where `findCutPoint` says it is safe**, which is reused rather than
 *   reimplemented. A naive `slice(-n)` can land between a `toolcall` and its `toolcallresponse`,
 *   and an orphaned call is a malformed conversation. That function already snaps to a turn
 *   boundary or the end of a completed tool round, and is already tested.
 * - **It always keeps the first user message**, re-attaching it at the front when the cut dropped
 *   it. That entry is the task statement; a window that slid past it would leave the model working
 *   on a goal it can no longer see. `AgentLoop.pinnedEntryId()` pins the same entry for
 *   compaction, for the same reason.
 */
export function windowEntries(
  entries: readonly ContextEntry[],
  budgetTokens: number,
): readonly ContextEntry[] {
  if (budgetTokens <= 0) return entries;
  const cut = findCutPoint(entries, budgetTokens);
  if (cut <= 0) return entries;

  const kept = entries.slice(cut);
  const pinned = firstUserInput(entries);
  // Only re-attached when the cut actually dropped it; `kept` keeps its own order either way, and
  // the pinned entry goes at the front because that is where it was.
  if (pinned && !kept.includes(pinned)) return [pinned, ...kept];
  return kept;
}

/**
 * Builds the component. Registered with `AgentLoop.registerCore()`.
 *
 * Named so `/mcp`-style introspection and the seam's warning text identify it, per
 * `CoreComponent.name`.
 */
export function slidingWindowComponent(options: SlidingWindowOptions = {}): CoreComponent {
  const control = slidingWindowControl(options);
  return control.component;
}

/**
 * A component whose window can be turned on and off while the session runs.
 *
 * Runtime-switchable rather than a startup flag, because of what this feature *is*: design doc
 * §2.4 calls it a strategy-level operation - something a session steps back to when it is under
 * pressure - and a thing you roll back to has to be reachable from where you are. It is also what
 * makes the reversibility real rather than theoretical: turning it off restores the full context
 * on the very next request, because nothing was ever changed.
 */
export interface SlidingWindowControl {
  readonly component: CoreComponent;
  /** The live settings, or `undefined` when the window is off. */
  current(): SlidingWindowOptions | undefined;
  /** Turns it on with these settings, or off with `undefined`. */
  set(next: SlidingWindowOptions | undefined): void;
}

/** Sum of the visible entries' estimates - the same measure `findCutPoint` uses. */
function visibleTokens(entries: readonly ContextEntry[]): number {
  let total = 0;
  for (const e of entries) if (e.agent_visible !== false) total += estimateTokens(e);
  return total;
}

/**
 * `windowEntries` with a memory (A10): the first kept entry is remembered and reused while the kept
 * part still fits `budget`; only when it outgrows it is a new cut taken, at `budget * hysteresis`.
 * Returns the projection and the id of the cut entry to remember (undefined = no cut).
 */
export function stickyWindowEntries(
  entries: readonly ContextEntry[],
  budget: number,
  previousCutId: string | undefined,
  hysteresis = WINDOW_HYSTERESIS,
): { kept: readonly ContextEntry[]; cutId: string | undefined } {
  if (budget <= 0) return { kept: entries, cutId: undefined };
  const pinned = firstUserInput(entries);
  const withPinned = (kept: readonly ContextEntry[]) => (pinned && !kept.includes(pinned) ? [pinned, ...kept] : kept);
  if (previousCutId !== undefined) {
    const at = entries.findIndex((e) => e.id === previousCutId);
    if (at > 0) {
      const kept = withPinned(entries.slice(at));
      if (visibleTokens(kept) <= budget) return { kept, cutId: previousCutId };
    }
  }
  if (previousCutId === undefined && visibleTokens(entries) <= budget) return { kept: entries, cutId: undefined };
  const cut = findCutPoint(entries, Math.floor(budget * Math.min(1, Math.max(0.1, hysteresis))));
  if (cut <= 0) return { kept: entries, cutId: undefined };
  return { kept: withPinned(entries.slice(cut)), cutId: entries[cut]!.id };
}

export function slidingWindowControl(initial?: SlidingWindowOptions): SlidingWindowControl {
  let active = initial;
  let cutId: string | undefined;

  return {
    current: () => active,
    set: (next) => {
      active = next;
      cutId = undefined;
    },
    component: {
      name: 'sliding-window',
      buildRequest: ({ entries, contextWindow }: RequestBuild) => {
        // Off is the common case for a component that is registered on first use and then left
        // registered, so this is checked before anything else is computed.
        if (!active) return entries;
        const budget =
          active.budgetTokens ??
          (contextWindow === undefined
            ? undefined
            : Math.floor(contextWindow * (active.fraction ?? DEFAULT_WINDOW_FRACTION)));
        // No budget means no basis for a decision. Returning `entries` unchanged is the right
        // no-op: this component existing must never make a session worse than not having it.
        if (budget === undefined) return entries;
        const result = stickyWindowEntries(entries, budget, cutId, active.hysteresis);
        cutId = result.cutId;
        return result.kept;
      },
    },
  };
}
