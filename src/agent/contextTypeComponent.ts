import { CONTINUATION_TAG, type ContextEntry } from './contextEntry.js';
import type { ContextWindowType, ContextWindowTypeControl } from './contextWindowType.js';
import type { CoreComponent, RequestBuild } from './coreSeam.js';
import { windowEntries } from './slidingWindow.js';

/**
 * Shapes each request by the context window type - NextUp item 23, checklist B2/B5/B6.
 *
 * A `buildRequest` projection (design doc 5.7): it never touches `AgentLoop`'s history, it returns
 * the list this one request is built from, and the seam's accounting measures what it returns. So
 * switching type mid-session is instant and loses nothing - `floating` again on the next request
 * sends everything it would have sent before.
 *
 * What it adds to a request (the `pointer` hint, the `curated` history) is folded into the text of
 * a user message rather than added as an entry of its own. A separate entry would put two user
 * messages side by side, which not every provider accepts, and it would have no real place in the
 * conversation. Clearly marked text inside the turn it belongs to reads as what it is.
 */

/** What `pointer` and `curated` need from the history side. Supplied by `session/` at startup; a
 * component without it behaves as `floating` for both, which is never worse than today. */
export interface ContextTypeRetrieval {
  /** The one-line hint for this request, or `undefined` when nothing qualifies (brief, Q8). */
  pointerHint?(request: string): string | undefined;
  /** The history to load ahead of the recent exchanges, or `undefined` for none (brief, Q4/Q5). */
  curatedHistory?(request: string, budgetTokens: number | undefined): Promise<string | undefined>;
}

export interface ContextTypeComponentOptions {
  readonly control: ContextWindowTypeControl;
  readonly retrieval?: ContextTypeRetrieval;
  /** `curated`'s budget for a model window - `curatedBudgetTokens`, injected so this file stays
   * free of the budget rules. */
  readonly curatedBudget?: (setting: ContextWindowType, contextWindow: number | undefined) => number | undefined;
  /** How many recent exchanges `curated` keeps verbatim. */
  readonly recentExchanges?: number;
  /** The share of the window those exchanges may take - `CURATED_RECENT_FRACTION`. Unset or an
   * unknown window means no bound, the original behaviour. */
  readonly recentFraction?: number;
}

/** Whether an entry is a message a person typed - not the loop's own continue nudge. */
export function isRealUserInput(entry: ContextEntry): boolean {
  return entry.type === 'user' && entry.sub_type === 'input' && !(entry.tags?.includes(CONTINUATION_TAG) ?? false);
}

/** Index of the current turn's user message, or -1 when there is none. */
export function currentTurnStart(entries: readonly ContextEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (isRealUserInput(entries[i])) return i;
  return -1;
}

/**
 * Index where the last `exchanges` turns begin (the current one counts as the last). Always a real
 * user message when there is one - with fewer turns than asked for it is the earliest, never index
 * 0, which can be a hidden notice that whatever is folded into it would vanish with.
 */
export function recentTurnsStart(entries: readonly ContextEntry[], exchanges: number): number {
  let seen = 0;
  let earliest = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isRealUserInput(entries[i])) continue;
    earliest = i;
    if (++seen === exchanges) return i;
  }
  return Math.max(earliest, 0);
}

/** A copy of `entry` with `text` put in front of what it says. */
function withPreamble(entry: ContextEntry, text: string): ContextEntry {
  return { ...entry, content: `${text}\n\n${entry.content}` };
}

/** A copy of `entry` with `text` added after what it says. */
function withNote(entry: ContextEntry, text: string): ContextEntry {
  return { ...entry, content: `${entry.content}\n\n${text}` };
}

export function contextTypeComponent(options: ContextTypeComponentOptions): CoreComponent {
  // Computed once per user message and reused for every request in that turn: a turn makes many
  // requests (one per tool round) and the hint must not change, or cost a search, between them.
  let pointerCache: { entryId: string; hint: string | undefined } | undefined;
  let curatedCache: { entryId: string; key: string; history: string | undefined } | undefined;

  return {
    name: 'context-window-type',
    buildRequest: async ({ entries, contextWindow, tokenRatio }: RequestBuild) => {
      // Budgets below are in real tokens; everything here measures in estimated ones.
      const ratio = tokenRatio && tokenRatio > 0 ? tokenRatio : 1;
      const setting = options.control.current();
      const turn = currentTurnStart(entries);
      if (turn < 0) return entries;
      const current = entries[turn];

      if (setting.type === 'none') return entries.slice(turn);

      if (setting.type === 'pointer') {
        if (!options.retrieval?.pointerHint) return entries;
        if (pointerCache?.entryId !== current.id) {
          pointerCache = { entryId: current.id, hint: options.retrieval.pointerHint(current.content) };
        }
        const hint = pointerCache.hint;
        if (!hint) return entries;
        return [...entries.slice(0, turn), withNote(current, hint), ...entries.slice(turn + 1)];
      }

      if (setting.type === 'curated') {
        if (!options.retrieval?.curatedHistory) return entries;
        const realBudget = options.curatedBudget?.(setting, contextWindow);
        const budget = realBudget === undefined ? undefined : Math.floor(realBudget / ratio);
        // Keyed on the real-token budget: the ratio is recalibrated after every response, and
        // keying on the scaled budget would re-run both curated calls on every request.
        const key = String(realBudget);
        if (curatedCache?.entryId !== current.id || curatedCache.key !== key) {
          curatedCache = { entryId: current.id, key, history: await options.retrieval.curatedHistory(current.content, budget) };
        }
        const start = recentTurnsStart(entries, options.recentExchanges ?? 3);
        let kept: readonly ContextEntry[] = entries.slice(start);
        // Bounded, never below the current turn: what is cut is the oldest tool rounds of the
        // earlier exchanges, at the sliding window's safe cut points (never between a call and its
        // result), with their first message pinned so the preamble below still has a home.
        if (options.recentFraction !== undefined && contextWindow !== undefined) {
          const turnStartInKept = kept.length - (entries.length - turn);
          if (turnStartInKept > 0) {
            const trimmed = windowEntries(kept, Math.floor((contextWindow * options.recentFraction) / ratio));
            // A bound smaller than the current turn would cut into it; then only the earlier
            // exchanges go, down to their first message.
            const keepsCurrentTurn = trimmed.length - (trimmed[0] === kept[0] ? 1 : 0) >= kept.length - turnStartInKept;
            kept = keepsCurrentTurn ? trimmed : [kept[0], ...kept.slice(turnStartInKept)];
          }
        }
        const history = curatedCache.history;
        if (!history || kept.length === 0) return kept;
        return [withPreamble(kept[0], history), ...kept.slice(1)];
      }

      return entries;
    },
  };
}
