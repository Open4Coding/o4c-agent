/**
 * The model as a name rather than a path. The local provider's model id comes from the server's
 * `/v1/models`, which for llama-server is the file it was launched with - on PHOEBE that is
 * `/media/sda/models/qwen3.8-27b-Q4_K_M-imatFP16.gguf`, 50 characters of which only the last 27
 * identify anything. The status line shares one row with five other segments, so it gets the name.
 *
 * Splits on both separators regardless of the host platform: the path comes from the *server*, so a
 * Windows client routinely sees POSIX paths (and could see the reverse). Anything without a
 * separator or extension - `claude-opus-5`, `local` - passes through untouched.
 */
export function formatModelName(model: string): string {
  const base = model.split(/[\\/]/).pop() ?? model;
  const trimmed = base.replace(/\.(gguf|bin|safetensors)$/i, '');
  // Never return nothing: a path ending in a separator would otherwise blank the segment entirely,
  // which reads as "no model" rather than "an oddly-named one".
  return trimmed || model;
}

/** `45.9657` -> `"46"`. Whole numbers above 10 (the difference between 46 and 45.97 is noise on a
 * figure that moves every turn), one decimal below, so a slow local model still shows a meaningful
 * rate instead of a flat `0`. The bare number: the `tks/s` label is part of the footer's token
 * line, which carries three values under one unit. Empty for anything unusable, so the caller can
 * show a placeholder rather than a fabricated `0`. */
export function formatTokenRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}`;
}

/** `12345` -> `"12.3K"`, matching the compact style the status bar needs - under 1000 shown
 * as-is, otherwise one decimal place under 10K and none above (so it never grows past 5 chars). */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
}

/** Each step up, largest first - a lifetime total outgrows `formatTokenCount`'s K-only scale
 * quickly (a single long local run is already tens of millions), and `50000K` is unreadable. */
const CUMULATIVE_UNITS = [
  { at: 1e12, suffix: 'T' },
  { at: 1e9, suffix: 'B' },
  { at: 1e6, suffix: 'M' },
  { at: 1e3, suffix: 'K' },
] as const;

/**
 * `12_345_678` -> `"12.3M"`. Same compact shape as `formatTokenCount` (one decimal under 10, none
 * above, never past 5 characters) but carried up through M/B/T, for the project and session
 * lifetime totals on the footer's token line.
 *
 * Returns `"0"` rather than an empty string for nothing-yet: a project that has spent no tokens is
 * a real, correct answer worth showing, unlike a throughput rate that has not been measured.
 */
export function formatCumulativeTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  for (const { at, suffix } of CUMULATIVE_UNITS) {
    if (n >= at) {
      const scaled = n / at;
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}${suffix}`;
    }
  }
  return String(Math.round(n));
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

/** The idle form of the clock: minutes only (`"<1m"` / `"31m"` / `"1h 9m"`). While nothing is
 * running the footer only refreshes once a minute, so showing seconds would display a stale value
 * that looks live. */
export function formatElapsedCoarse(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** How often the footer clock re-renders: every second while a turn runs (seconds are shown and
 * worth watching), once a minute at idle. Every re-render repaints the whole live frame, so a
 * one-second tick on an idle screen was ~1 repaint/s forever. */
export function elapsedTickMs(busy: boolean): number {
  return busy ? 1000 : 60_000;
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
