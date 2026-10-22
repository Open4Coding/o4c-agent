/**
 * Parsing and describing the `/window` argument - checklist item 40's switch.
 *
 * Its own module rather than two helpers inside `App.tsx` so the parsing is testable without
 * rendering anything, which is the same split `thinkLevel.ts` and `modePolicy.ts` already use.
 */

import { DEFAULT_WINDOW_FRACTION, type SlidingWindowOptions } from '../agent/slidingWindow.js';

/** Below this a budget cannot hold even one exchange, so it is rejected rather than honoured. */
export const MIN_WINDOW_TOKENS = 500;

/**
 * Reads `40000`, `40k`, `50%` or `0.5` into settings, or `undefined` if it is none of those.
 *
 * A bare number under 1 is read as a fraction, because `/window 0.5` is a natural way to ask for
 * half and the alternative reading - half a token - is not a thing anyone wants. Above that, a
 * bare number is a token count: the two cannot be confused, since no useful window is under one
 * token and no fraction is over one.
 */
export function parseWindowSetting(input: string): SlidingWindowOptions | undefined {
  const text = input.trim().toLowerCase();
  if (!text) return undefined;

  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) {
    const fraction = Number(percent[1]) / 100;
    return fraction > 0 && fraction <= 1 ? { fraction } : undefined;
  }

  const suffixed = /^(\d+(?:\.\d+)?)\s*k$/.exec(text);
  if (suffixed) {
    const tokens = Math.round(Number(suffixed[1]) * 1000);
    return tokens >= MIN_WINDOW_TOKENS ? { budgetTokens: tokens } : undefined;
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const value = Number(text);
  if (value > 0 && value < 1) return { fraction: value };
  return value >= MIN_WINDOW_TOKENS ? { budgetTokens: Math.round(value) } : undefined;
}

/** How the setting reads back to the user, in the same terms they could have typed. */
export function describeWindowSetting(options: SlidingWindowOptions): string {
  if (options.budgetTokens !== undefined) {
    return `${options.budgetTokens.toLocaleString()} tokens`;
  }
  const fraction = options.fraction ?? DEFAULT_WINDOW_FRACTION;
  return `${Math.round(fraction * 100)}% of the context window`;
}
