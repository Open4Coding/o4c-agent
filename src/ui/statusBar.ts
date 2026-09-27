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

/** A fixed-width `[███░░░░░░░]`-style bar - `fraction` is clamped to [0, 1] so a token estimate
 * that overshoots a configured `contextWindow` (the chars/4 heuristic is approximate, per
 * `contextEntry.ts`'s own `estimateTokens`) never renders a bar wider than `width`. */
export function renderProgressBar(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}
