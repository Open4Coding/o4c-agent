import type { SlidingWindowOptions } from './slidingWindow.js';

/**
 * The four context window types - NextUp item 23, design brief 0004. Chosen with
 * `/set-contextwindowtype`, saved in `config.json` under `contextWindowType`, and read fresh on
 * every launch, so o4c's per-turn reload keeps it with no restart flag (the same route
 * `/datagraph` takes). Parsing and wording live in `ui/contextWindowSetting.ts`; this module is
 * what the core components need, and imports nothing from the UI.
 *
 * Within one turn every type keeps that turn's own tool calls and results; a type only governs
 * what carries **across** turns:
 *
 * - `none` - only the current turn is sent, and nothing is written to the history store.
 * - `floating` - the conversation, sized by `/window` (off = all of it). Today's behaviour and the
 *   default until the long-run test shows `pointer` earns it (brief, Q11).
 * - `pointer` - floating, plus a one-line hint naming past tasks that match, which the model can
 *   open with `search_history`. Costs nothing on a turn where nothing qualifies.
 * - `curated` - before the turn the model searches the history and picks what to load (two short
 *   calls), up to a budget, alongside the last three exchanges verbatim.
 */

export const CONTEXT_WINDOW_TYPES = ['none', 'floating', 'pointer', 'curated'] as const;
export type ContextWindowTypeName = (typeof CONTEXT_WINDOW_TYPES)[number];

/** The config key, holding exactly what follows the command name: `pointer`, `curated 20%`. */
export const CONTEXT_WINDOW_TYPE_CONFIG_KEY = 'contextWindowType';

export const DEFAULT_CONTEXT_WINDOW_TYPE: ContextWindowTypeName = 'floating';

/** `curated`'s default budget: 15% of the model's window, capped at 30K tokens (brief, Q5). The
 * cap applies to the default only - a budget typed explicitly is honoured as typed. */
export const CURATED_DEFAULT_FRACTION = 0.15;
export const CURATED_DEFAULT_CAP_TOKENS = 30_000;

/** How many recent exchanges `curated` keeps verbatim alongside what it loads (brief, Q3). */
export const CURATED_RECENT_EXCHANGES = 3;

/**
 * The most of the model's window those recent exchanges may take, verbatim. Found on the tmp4 long
 * run (2026-11-01): one exchange there is a whole 50-call turn, so three of them filled 190K of a
 * 229K window by themselves and `curated` sent more than `floating` would. Past this share, the
 * oldest tool rounds are cut at a safe boundary - the sliding window's own rule - and the current
 * turn is always kept whole.
 *
 * 0.35 rather than the half it started at: the cut is measured in the chars/4 estimate, and on
 * code-heavy content real tokens ran about 1.3x that, so "half" landed near 65% and, with the
 * curated history on top, tripped the 80% compaction line on the very first request of a turn.
 */
export const CURATED_RECENT_FRACTION = 0.35;

export interface ContextWindowType {
  readonly type: ContextWindowTypeName;
  /** `curated` only: an explicit budget. Absent means the default above. */
  readonly budget?: SlidingWindowOptions;
}

/** One line per type, for the command's own help and its no-argument listing. */
export const CONTEXT_WINDOW_TYPE_INFO: Record<ContextWindowTypeName, string> = {
  none: 'only the current message is sent; one-shot answers, nothing kept in history',
  floating: 'the recent conversation, sized by /window (the default)',
  pointer: 'floating, plus a one-line hint naming matching past tasks the model can open',
  curated: 'the model searches past tasks and loads what it picks, plus the last 3 exchanges',
};

/** `curated`'s budget in tokens for a model window, or `undefined` when the window is unknown and
 * no explicit token budget was given - the same "never guess the window" rule `/window` follows. */
export function curatedBudgetTokens(setting: ContextWindowType, contextWindow: number | undefined): number | undefined {
  if (setting.budget?.budgetTokens !== undefined) return setting.budget.budgetTokens;
  if (contextWindow === undefined) return undefined;
  if (setting.budget?.fraction !== undefined) return Math.floor(contextWindow * setting.budget.fraction);
  return Math.min(CURATED_DEFAULT_CAP_TOKENS, Math.floor(contextWindow * CURATED_DEFAULT_FRACTION));
}

/** The live setting, shared by everything that depends on it: the recorder (off for `none`), the
 * request-building components, and the command that changes it. */
export interface ContextWindowTypeControl {
  current(): ContextWindowType;
  set(next: ContextWindowType): void;
  /** Called after every `set` - how `search_history` appears and disappears with the type. */
  onChange(listener: (next: ContextWindowType) => void): void;
}

export function contextWindowTypeControl(initial: ContextWindowType): ContextWindowTypeControl {
  let active = initial;
  const listeners: Array<(next: ContextWindowType) => void> = [];
  return {
    current: () => active,
    set: (next) => {
      active = next;
      for (const listener of listeners) listener(next);
    },
    onChange: (listener) => {
      listeners.push(listener);
    },
  };
}

/** Whether a type offers the model `search_history`: the two that point it at past tasks. */
export function offersHistorySearch(setting: ContextWindowType): boolean {
  return setting.type === 'pointer' || setting.type === 'curated';
}
