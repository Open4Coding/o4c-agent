/**
 * Reading, writing and describing a `/set-contextwindowtype` value - the UI half of
 * `agent/contextWindowType.ts`, split off so the core never imports from `ui/` (the same split
 * `windowSetting.ts` makes for `/window`).
 */

import {
  CONTEXT_WINDOW_TYPES,
  CURATED_DEFAULT_CAP_TOKENS,
  CURATED_DEFAULT_FRACTION,
  DEFAULT_CONTEXT_WINDOW_TYPE,
  type ContextWindowType,
} from '../agent/contextWindowType.js';
import { describeWindowSetting, parseWindowSetting } from './windowSetting.js';

/** Reads `pointer`, `curated`, `curated 20%`, `curated 20000`; `undefined` for anything else.
 * Only `curated` takes a budget. */
export function parseContextWindowType(input: string): ContextWindowType | undefined {
  const [word, ...rest] = input.trim().toLowerCase().split(/\s+/);
  const type = CONTEXT_WINDOW_TYPES.find((t) => t === word);
  if (!type) return undefined;
  const budgetText = rest.join(' ');
  if (!budgetText) return { type };
  if (type !== 'curated') return undefined;
  const budget = parseWindowSetting(budgetText);
  return budget ? { type, budget } : undefined;
}

/** The setting in the form it was typed and is stored: the inverse of `parseContextWindowType`. */
export function formatContextWindowType(setting: ContextWindowType): string {
  if (!setting.budget) return setting.type;
  const { budgetTokens, fraction } = setting.budget;
  return `${setting.type} ${budgetTokens !== undefined ? budgetTokens : `${Math.round((fraction ?? 0) * 100)}%`}`;
}

/** How the setting reads back to the user. */
export function describeContextWindowType(setting: ContextWindowType): string {
  if (setting.type !== 'curated') return setting.type;
  return setting.budget
    ? `curated, loading up to ${describeWindowSetting(setting.budget)}`
    : `curated, loading up to ${Math.round(CURATED_DEFAULT_FRACTION * 100)}% of the context window (at most ${CURATED_DEFAULT_CAP_TOKENS.toLocaleString()} tokens)`;
}

/** The saved value as read from config; anything unreadable is the default rather than an error -
 * a hand-edited typo must not stop o4c from starting. */
export function contextWindowTypeFromConfig(raw: unknown): ContextWindowType {
  return (typeof raw === 'string' ? parseContextWindowType(raw) : undefined) ?? { type: DEFAULT_CONTEXT_WINDOW_TYPE };
}
