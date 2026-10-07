import { estimateTextTokens } from '../agent/contextEntry.js';

/**
 * A single tool result's own size budget - the one thing that was never bounded anywhere, and the
 * direct cause of two dead runs on 2026-10-06: the model asked for `dir /s /b D:\AngelCode` (a
 * 24-character call) and `run_shell` handed back 11,370,857 chars - about 2.8M tokens, roughly 15x
 * a 229,376-token window - in one `toolcallresponse`, on the second tool call of the session.
 *
 * Every context-window guard this codebase has (`shouldCompact`, `maybeMicroCompact`,
 * `pauseAndCompactIfOverEighty`, the pre-send hard stop) sits DOWNSTREAM of the append, so none of
 * them can do anything about a single entry that is already bigger than the whole window: the real
 * logs show MicroCompact freeing 29 tokens against a 3.4M-token entry, `findCutPoint` returning 0
 * for want of an earlier turn boundary, and the hard stop correctly refusing to send - a dead
 * session rather than a crash, but dead either way. The bound has to exist before the append, which
 * is what this module is for.
 *
 * Deliberately NOT part of the compaction/estimate machinery it protects: nothing here reads or
 * changes `hybridPromptTokenEstimate`, `tokenRatio`, `hardStopReserveTokens`, `dynamicMaxTokens` or
 * `compactionSettingsForWindow`. Downstream simply sees a smaller string.
 */

/** Share of the model's window one tool result may occupy. 10% leaves a 229K window's result at
 * ~40K chars - about 1,300 lines of file paths, and comfortably above the largest genuinely useful
 * result observed in a real surviving run (20,440 chars). Real Claude Code uses a flat 30,000-char
 * cap for shell output; this scales instead, because o4c's per-slot window is as small as 57K when
 * llama-server runs `--parallel 4`. */
export const TOOL_OUTPUT_WINDOW_FRACTION = 0.1;

/** Floor, so a tiny window (or a unit-test window) still allows a usable result rather than
 * truncating everything down to the marker. */
export const MIN_TOOL_OUTPUT_TOKENS = 1_000;

/** Ceiling, so a very large window doesn't let one result swallow 100K tokens just because it can. */
export const MAX_TOOL_OUTPUT_TOKENS = 10_000;

/**
 * Chars per token - the exact inverse of `estimateTextTokens()` (chars/4), restated here rather
 * than imported because that function only converts one way. `toolOutput.test.ts` asserts the two
 * stay in agreement (`estimateTextTokens(maxToolOutputChars(w)) === maxToolOutputTokens(w)`), so
 * this can't silently drift from the convention the rest of the codebase estimates with.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Same shape as `compactionSettingsForWindow()` - pure, window in, budget out, so every
 * window-derived size in the codebase reads the same way.
 *
 * An unknown window (undefined, zero or negative - `RunOptions.contextWindow` is optional, and a
 * provider with no probe can leave it unset) falls back to the absolute ceiling rather than to "no
 * limit at all": there is nothing to scale against, but a tool result still must not be unbounded,
 * which is this module's entire purpose. Same absolute bound a very large window gets.
 */
export function maxToolOutputTokens(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return MAX_TOOL_OUTPUT_TOKENS;
  const scaled = Math.round(contextWindow * TOOL_OUTPUT_WINDOW_FRACTION);
  return Math.min(MAX_TOOL_OUTPUT_TOKENS, Math.max(MIN_TOOL_OUTPUT_TOKENS, scaled));
}

export function maxToolOutputChars(contextWindow: number | undefined): number {
  return maxToolOutputTokens(contextWindow) * CHARS_PER_TOKEN;
}

/** Head/tail split of whatever content budget survives the marker: the head matters for a listing
 * (the first entries are as representative as any), the tail for a failure (an error message,
 * exit code or summary line lands at the end). */
const HEAD_SHARE = 0.7;

/** Reserved for the marker itself, plus the spill path's own length - the marker has to fit INSIDE
 * `maxChars`, or capping the output wouldn't actually cap anything. */
const MARKER_ALLOWANCE_CHARS = 320;

/** Don't snap a cut back to a line boundary if doing so would throw away more than this share of
 * that side's budget - a 10 MB single-line payload has no newline to snap to, and chasing one
 * would discard the whole side. */
const MAX_SNAP_SHARE = 0.1;

export interface TruncatedToolOutput {
  /** What the model sees - guaranteed no longer than the `maxChars` passed in. */
  text: string;
  truncated: boolean;
  /** Size of the original, before truncation - what the marker reports and callers can log. */
  originalChars: number;
}

/** Cuts back to the last newline at or before `end`, unless that discards too much (see
 * `MAX_SNAP_SHARE`) - keeps whole lines intact without risking a near-empty slice. */
function snapHeadEnd(text: string, end: number): number {
  const boundary = text.lastIndexOf('\n', end);
  if (boundary <= 0) return end;
  return end - boundary > Math.ceil(end * MAX_SNAP_SHARE) ? end : boundary;
}

/** Mirror of `snapHeadEnd` for the tail: forward to just after the next newline. */
function snapTailStart(text: string, start: number): number {
  const boundary = text.indexOf('\n', start);
  if (boundary < 0) return start;
  const budget = text.length - start;
  return boundary + 1 - start > Math.ceil(budget * MAX_SNAP_SHARE) ? start : boundary + 1;
}

function buildMarker(
  originalChars: number,
  originalTokens: number,
  maxChars: number,
  headChars: number,
  tailChars: number,
  spillPath?: string,
): string {
  const parts = [
    `[o4c truncated this output: ${originalChars.toLocaleString()} chars`,
    ` (~${originalTokens.toLocaleString()} tokens)`,
    ` exceeded the ${maxChars.toLocaleString()}-char limit.`,
    ` First ${headChars.toLocaleString()} and last ${tailChars.toLocaleString()} chars shown.`,
  ];
  if (spillPath) parts.push(` Full output: ${spillPath}.`);
  parts.push(' Read a slice with read_file offset/limit, or narrow the command.]');
  return parts.join('');
}

/**
 * Bounds one tool result to `maxChars`, keeping the head and the tail and replacing the middle with
 * a marker that says what was dropped, how big the original was, and where the full text is on disk
 * (when it was spilled). Output shorter than the budget is returned byte-identical - the common
 * case, and it must stay free of surprises.
 */
export function truncateToolOutput(text: string, maxChars: number, spillPath?: string): TruncatedToolOutput {
  const originalChars = text.length;
  if (originalChars <= maxChars) return { text, truncated: false, originalChars };

  const markerAllowance = MARKER_ALLOWANCE_CHARS + (spillPath?.length ?? 0);
  const contentBudget = Math.max(0, maxChars - markerAllowance);
  const headEnd = snapHeadEnd(text, Math.ceil(contentBudget * HEAD_SHARE));
  const tailStart = snapTailStart(text, originalChars - (contentBudget - headEnd));
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const marker = buildMarker(originalChars, estimateTextTokens(text), maxChars, head.length, tail.length, spillPath);

  let result = `${head}\n${marker}\n${tail}`;
  // Defensive: the marker is built from real lengths, so it can run a little longer than the
  // allowance reserved for it (a very long spill path, huge char counts). Trim the tail rather
  // than return something over the budget this function exists to enforce.
  if (result.length > maxChars) {
    const overflow = result.length - maxChars;
    result = `${head}\n${marker}\n${tail.slice(Math.min(overflow, tail.length))}`;
  }
  return { text: result.slice(0, maxChars), truncated: true, originalChars };
}

/**
 * Writes the untruncated output to disk so truncation never loses anything - the model gets a
 * bounded slice plus this path, and can `read_file` whatever part of it actually matters.
 *
 * Best-effort and must never reject, same discipline as `RunLogger.log()`: a failed spill (no
 * project dir, read-only disk, a full volume) degrades to a truncation marker without a path,
 * which is still a correct, bounded result. Losing a turn over a diagnostic file write would be a
 * worse outcome than losing the file. Filename matches `RunLogger`'s one-file-per-run convention,
 * plus a short random suffix because several tool calls in one iteration can land in the same
 * millisecond.
 */
export async function spillToolOutput(dir: string | undefined, toolName: string, text: string): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTool = toolName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'tool';
    const path = join(dir, `${stamp}.${safeTool}.${randomUUID().slice(0, 6)}.txt`);
    await writeFile(path, text, 'utf-8');
    return path;
  } catch {
    return undefined;
  }
}
