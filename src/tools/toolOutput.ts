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

/**
 * The same bound for the other end of the pipe: one *user* message. Tool results were the first
 * unbounded entry found (2026-10-06, an 11 MB `dir /s /b`), but a pasted megabyte has always had
 * exactly the same shape - `caeb443` collapses a large paste in the UI, and nothing capped the
 * entry behind it.
 *
 * Made urgent by two findings on 2026-10-07. First, the **pin**: `AgentLoop.pinnedEntryId()` keeps
 * the first user message visible for the whole session (compaction had been hiding and destroying
 * it, losing the model its own task), so an unbounded first message is now permanently resident
 * rather than merely temporarily large. Second, **the window is not a constant**: llama.cpp divides
 * `n_ctx` across `--parallel` slots and o4c re-probes the per-slot size at every launch
 * (`cli.ts:416`), so the same session resumed after a server restart can land in a window several
 * times smaller - 229,376 at `--parallel 1`, 57,344 at 4, 14,336 at 16. A fraction of the window
 * scales with that automatically; a flat char count would not.
 *
 * Bounding at the append site is deliberate, and is why there is no truncation logic inside
 * `maybeCompact()`: one bound, at the boundary, upstream of every tuned budget - the same shape that
 * made `boundToolOutput()` work and left `pruneOversizedToolResults()` as a pure recovery path for
 * history that predates it.
 *
 * Ceiling is higher than a tool result's 10,000. A task statement is re-read on every single request
 * and is the one entry nothing else in the log can substitute for, so it earns more room than a
 * directory listing; the 10% fraction binds first below a ~250K window anyway. For scale: a real
 * task prompt measured 793 tokens, comfortably inside the 1,434-token budget even at the smallest
 * window above, so this only ever bites on a genuine paste.
 */
export const USER_INPUT_WINDOW_FRACTION = 0.1;
export const MIN_USER_INPUT_TOKENS = 1_000;
export const MAX_USER_INPUT_TOKENS = 25_000;

export function maxUserInputTokens(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return MAX_USER_INPUT_TOKENS;
  const scaled = Math.round(contextWindow * USER_INPUT_WINDOW_FRACTION);
  return Math.min(MAX_USER_INPUT_TOKENS, Math.max(MIN_USER_INPUT_TOKENS, scaled));
}

export function maxUserInputChars(contextWindow: number | undefined): number {
  return maxUserInputTokens(contextWindow) * CHARS_PER_TOKEN;
}

/**
 * How far past the budget an ALREADY-APPENDED tool result has to be before `maybeMicroCompact()`
 * hides it regardless of age (`AgentLoop.pruneOversizedToolResults()`).
 *
 * Nothing going through `boundToolOutput()` can ever reach this, by construction - it exists for
 * entries that predate the cap: a session saved before this code shipped and reloaded by `/resume`
 * (the 2026-10-06 runs left an 11.4 MB one on disk), or any future path that appends a result
 * without going through the loop's single call site. A multiple rather than the budget itself, so a
 * result that merely sits near the limit is never silently thrown away - this is a recovery
 * mechanism for the genuinely pathological case, not a second truncation tier.
 */
export const OVERSIZED_TOOL_RESULT_MULTIPLE = 2;

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

/** Builds the text that replaces the elided middle. Parameterized so the two kinds of oversized
 * entry can explain themselves in their own terms - telling the model to "narrow the command" about
 * something the *user* typed would be actively misleading. */
type MarkerBuilder = (parts: {
  originalChars: number;
  originalTokens: number;
  maxChars: number;
  headChars: number;
  tailChars: number;
  spillPath?: string;
}) => string;

const toolOutputMarker: MarkerBuilder = (p) => {
  const parts = [
    `[o4c truncated this output: ${p.originalChars.toLocaleString()} chars`,
    ` (~${p.originalTokens.toLocaleString()} tokens)`,
    ` exceeded the ${p.maxChars.toLocaleString()}-char limit.`,
    ` First ${p.headChars.toLocaleString()} and last ${p.tailChars.toLocaleString()} chars shown.`,
  ];
  if (p.spillPath) parts.push(` Full output: ${p.spillPath}.`);
  parts.push(' Read a slice with read_file offset/limit, or narrow the command.]');
  return parts.join('');
};

const userInputMarker: MarkerBuilder = (p) => {
  const parts = [
    `[o4c truncated this message: ${p.originalChars.toLocaleString()} chars`,
    ` (~${p.originalTokens.toLocaleString()} tokens)`,
    ` exceeded the ${p.maxChars.toLocaleString()}-char limit.`,
    ` First ${p.headChars.toLocaleString()} and last ${p.tailChars.toLocaleString()} chars shown.`,
  ];
  // No "narrow the command" advice: the model did not cause this and cannot re-issue it. The spill
  // path is the only actionable thing, and it is the whole message, verbatim.
  if (p.spillPath) parts.push(` Full message: ${p.spillPath} - read it with read_file offset/limit.`);
  else parts.push(' The middle is not recoverable from here - ask the user for the part you need.');
  parts.push(']');
  return parts.join('');
};

/**
 * Head+tail truncation with the middle replaced by an explanatory marker. Shared by both public
 * wrappers below so there is exactly one implementation of the bounding arithmetic (and one set of
 * edge cases: the marker allowance, the line-boundary snapping, the defensive final trim) rather
 * than a second copy that can drift. Text already within budget is returned byte-identical - the
 * common case, and it must stay free of surprises.
 */
function truncateWithMarker(
  text: string,
  maxChars: number,
  makeMarker: MarkerBuilder,
  spillPath?: string,
): TruncatedToolOutput {
  const originalChars = text.length;
  if (originalChars <= maxChars) return { text, truncated: false, originalChars };

  const markerAllowance = MARKER_ALLOWANCE_CHARS + (spillPath?.length ?? 0);
  const contentBudget = Math.max(0, maxChars - markerAllowance);
  const headEnd = snapHeadEnd(text, Math.ceil(contentBudget * HEAD_SHARE));
  const tailStart = snapTailStart(text, originalChars - (contentBudget - headEnd));
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const marker = makeMarker({
    originalChars,
    originalTokens: estimateTextTokens(text),
    maxChars,
    headChars: head.length,
    tailChars: tail.length,
    spillPath,
  });

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
 * Bounds one tool result to `maxChars`, keeping the head and the tail and replacing the middle with
 * a marker that says what was dropped, how big the original was, and where the full text is on disk
 * (when it was spilled).
 */
export function truncateToolOutput(text: string, maxChars: number, spillPath?: string): TruncatedToolOutput {
  return truncateWithMarker(text, maxChars, toolOutputMarker, spillPath);
}

/**
 * Bounds one user message, same mechanics as `truncateToolOutput` with wording that fits a message
 * the model did not cause and cannot re-issue. See `maxUserInputTokens()` for why this exists at
 * all; the head is where a task's instructions live, which is why `HEAD_SHARE` favouring it matters
 * more here than for a directory listing.
 */
export function truncateUserInput(text: string, maxChars: number, spillPath?: string): TruncatedToolOutput {
  return truncateWithMarker(text, maxChars, userInputMarker, spillPath);
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
