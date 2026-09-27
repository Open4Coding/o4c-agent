/** `12345` -> `"12.3K"`, matching the compact style the status bar needs - under 1000 shown
 * as-is, otherwise one decimal place under 10K and none above (so it never grows past 5 chars). */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
}

/** `ms` since session start -> `"29s"` / `"9m 12s"` / `"1h 9m"` - drops the smallest unit once
 * the next one up is non-zero, so the string never grows past two components. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** How many of `width` cells should render as "filled" - `fraction` clamped to [0, 1] so a token
 * estimate that overshoots a configured `contextWindow` (the chars/4 heuristic is approximate,
 * per `contextEntry.ts`'s own `estimateTokens`) never overflows the bar. Shared by
 * `renderProgressBar()` (plain text) and the TUI's own two-color rendering (`App.tsx`'s
 * `StatusBar`) so both always agree on where the fill line falls. */
export function progressBarFilledCells(fraction: number, width = 10): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return Math.round(clamped * width);
}

/** A fixed-width `[███░░░░░░░]`-style bar as one plain string - for `/context`'s plain-text
 * output, which has no per-character coloring to lean on. The TUI's live status bar renders the
 * same fill count as two separately-colored `<Text>` spans instead (see `progressBarFilledCells`)
 * - real bug found via direct user report: one uniform color across the whole bar made the empty
 * `░` cells nearly as visually prominent as the filled `█` ones, so the bar looked "full"
 * regardless of actual usage. */
export function renderProgressBar(fraction: number, width = 10): string {
  const filled = progressBarFilledCells(fraction, width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}
