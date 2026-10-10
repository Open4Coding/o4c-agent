import type { Line } from './types.js';

/**
 * One permanently-committed block of the terminal's scrollback - exactly what Ink's `<Static>`
 * renders once and never revisits. Static writes are append-only and irreversible (see
 * `resizeReflowFix.ts`'s header comment: remounting `<Static>` to "fix" it duplicates the entire
 * conversation, because Static has no concept of replacing what it already wrote) - `id` is only
 * ever assigned once, by `textWindowReducer`'s `commit` action, never reused or reassigned.
 */
export interface TextBlock {
  readonly id: number;
  readonly lines: readonly Line[];
  /** A chunk of streamed output committed mid-turn (`full` view only), rather than a whole event
   * or turn. Rendered with no bottom margin and without the labelled-line gap rule, so the many
   * chunks one continuous think block or answer arrives in read as the single piece of text they
   * are instead of as a series of separate blocks. */
  readonly flow?: boolean;
}

/**
 * The data structure behind everything Ink actually draws for this app: `blocks` is the
 * permanent, append-only scrollback fed straight to `<Static items={blocks}>`; `live` is the
 * single in-flight region repainted every frame while a turn is running - replaced or cleared
 * wholesale, never something `<Static>` could own since Static can only ever grow. `nextId` is
 * this state's own counter (not a module-level mutable global, which is what `App.tsx` used
 * before this existed) - a fresh `initialTextWindow()` genuinely starts clean, and multiple
 * independent windows (e.g. in tests) never share or leak ids into each other.
 */
export interface TextWindowState {
  readonly blocks: readonly TextBlock[];
  readonly live: readonly string[];
  readonly nextId: number;
  /** Whether the last `live` line is an in-progress streamed-text line that the next
   * `appendDelta` should keep growing, rather than a distinct line (a tool call/result, the scan
   * summary, ...) that a delta should never be concatenated onto. Reset by everything else that
   * touches `live` - only `appendDelta` itself sets it true. */
  readonly deltaActive: boolean;
  /** Max characters the in-flight `live` region may hold - older content beyond this is dropped
   * from the head as new content arrives. The live region is a rolling preview, not a record
   * (the full content is already persisted: run log, session entries, full-context log), and an
   * uncapped region is what pushed Ink's live frame past the viewport height: on Windows that
   * routes every frame through Ink's full-terminal-clear + whole-history-rewrite path (ink.js
   * `shouldClearTerminalForFrame`), which is the visible screen-reset on long think blocks.
   * Sized to the terminal by the caller (App.tsx); `DEFAULT_LIVE_CAP_CHARS` is the fallback for
   * callers without a viewport (tests). */
  readonly liveCapChars: number;
  /** Max terminal ROWS the live region may occupy once wrapped to `liveCols` (undefined = no row
   * bound, characters only). `liveCapChars` alone can't keep the frame under the viewport:
   * text made of many short lines spans far more rows than chars/cols, and a frame at or above
   * the viewport height is what triggers Ink's win32 full-terminal-clear path. */
  readonly liveCapRows?: number;
  readonly liveCols?: number;
}

export type TextWindowAction =
  | { type: 'commit'; lines: Line[]; flow?: boolean }
  | { type: 'appendLive'; text: string }
  /** Replaces the whole live region with the one partial line a stream has not finished yet
   * (`full` view's progressive commit - see `commitStreamText` in App.tsx). Everything before it
   * is already permanent scrollback, so the live region holds a single unfinished line rather
   * than a rolling window of the turn, and nothing it drops was ever the only copy. */
  | { type: 'setLiveTail'; text: string }
  /** Re-bounds the live region after a terminal resize. The caps are otherwise fixed at mount, so a
   * window that shrinks mid-session would let the live frame grow past the viewport. */
  | { type: 'setLiveCaps'; liveCapChars: number; liveCapRows?: number; liveCols?: number }
  /** Raw streamed text chunks (`AgentEvent.type === 'delta'`) - appended onto the current live
   * line while a stream is in progress (`deltaActive`), or start a fresh line otherwise. This is
   * the one `live`-mutating action that doesn't mean "a new, distinct line" - see `deltaActive`.
   * `startNewLine` forces the fresh-line behavior even while `deltaActive` is already true - the
   * one case that needs it: a delta stream transitioning kind (reasoning ending, the real answer
   * beginning) mid-turn, which should visually start its own line rather than run on from
   * whatever was streaming before it. */
  | { type: 'appendDelta'; text: string; startNewLine?: boolean }
  /** The `[scan] N more tool calls collapsed...` running summary line updates in place as the
   * count grows, rather than appending a new line per tool event once collapsing starts - the one
   * genuinely stateful (as opposed to append-only) update the live region needs. */
  | { type: 'updateScanSummary'; text: string }
  | { type: 'clearLive' }
  /** `/clear`/`/resume` replace the whole window wholesale with a fresh (or restored) block list -
   * distinct from `commit`, which only ever adds one block to what's already there. */
  | { type: 'reset'; blocks: TextBlock[] };

const SCAN_SUMMARY_PREFIX = '[scan] ';

/** Fallback live-region budget for callers without a real viewport (tests, one-shot mode). */
export const DEFAULT_LIVE_CAP_CHARS = 4000;

/** How many lines' worth of streamed text must be buffered before it is flushed to the screen
 * early, instead of waiting for the heartbeat timer. */
export const DELTA_FLUSH_LINES = 5;

/**
 * True once `buffered` holds at least `DELTA_FLUSH_LINES` lines of streamed text - either that
 * many newlines, or that many terminal widths of characters (prose arrives as long wrapped lines
 * with few real newlines). Coalescing to line groups instead of repainting every few
 * milliseconds is what cuts the terminal write volume; the timer in `App.tsx` is only the
 * heartbeat that keeps a slow stream visibly moving.
 */
export function shouldFlushDelta(buffered: string, cols: number): boolean {
  if (buffered.length >= Math.max(1, cols) * DELTA_FLUSH_LINES) return true;
  let newlines = 0;
  for (let i = buffered.indexOf('\n'); i !== -1; i = buffered.indexOf('\n', i + 1)) {
    if (++newlines >= DELTA_FLUSH_LINES) return true;
  }
  return false;
}

/**
 * Hard bound on how long an unfinished streamed line may get before it is committed anyway. A
 * model that writes a whole section as one unbroken paragraph would otherwise keep it out of
 * scrollback until its first newline - exactly the rolling-window loss `full` view exists to end.
 */
export const STREAM_TAIL_CAP_CHARS = 2000;

/**
 * Splits streamed text into the finished lines that can be committed to scrollback now and the
 * unfinished remainder that has to stay live until more arrives. A remainder past
 * `STREAM_TAIL_CAP_CHARS` is broken at its last space (or hard, if the paragraph has no space in
 * reach) and committed too, so no amount of newline-free output can sit uncommitted forever.
 *
 * Pure and exported for its own test - the caller (`commitStreamText` in App.tsx) is inside a
 * component and would otherwise only be reachable through a full render.
 */
export function splitStreamLines(pending: string, cap: number = STREAM_TAIL_CAP_CHARS): { lines: string[]; tail: string } {
  const lines: string[] = [];
  let rest = pending;
  for (let nl = rest.indexOf('\n'); nl !== -1; nl = rest.indexOf('\n')) {
    lines.push(rest.slice(0, nl));
    rest = rest.slice(nl + 1);
  }
  if (rest.length > cap) {
    const space = rest.lastIndexOf(' ', cap);
    if (space > 0) {
      lines.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
    } else {
      lines.push(rest.slice(0, cap));
      rest = rest.slice(cap);
    }
  }
  return { lines, tail: rest };
}

function liveCharCount(live: readonly string[]): number {
  let total = 0;
  for (const line of live) total += line.length;
  return total;
}

/**
 * Drops the oldest live content until the region fits `cap` characters, keeping the newest -
 * the head of the region is exactly what has already scrolled past the user, so trimming it is
 * loss-free for them (see `liveCapChars`'s own doc comment on where the full record lives).
 * Whole lines are dropped first; if the overflow ends mid-line, that line is cut to its tail.
 * Returns the input array unchanged when already within the budget.
 */
export function trimLiveToCap(live: readonly string[], cap: number): string[] {
  const overflow = liveCharCount(live) - cap;
  if (overflow <= 0) return [...live];
  const result: string[] = [];
  let dropped = 0;
  for (const line of live) {
    if (dropped >= overflow) {
      result.push(line);
    } else if (line.length <= overflow - dropped) {
      dropped += line.length;
    } else {
      result.push(line.slice(overflow - dropped));
      dropped = overflow;
    }
  }
  return result;
}

/** Rows `text` occupies in a `cols`-wide terminal: each newline-separated segment wraps to
 * ceil(len/cols) rows, minimum one. Approximate by design (ignores wide glyphs and ANSI width) -
 * the 10-row margin in the cap absorbs the error. */
export function rowsFor(text: string, cols: number): number {
  const c = Math.max(1, cols);
  let rows = 0;
  for (const seg of text.split('\n')) rows += Math.max(1, Math.ceil(seg.length / c));
  return rows;
}

/**
 * Drops the oldest live content until the region fits `maxRows` terminal rows at `cols` width,
 * keeping the newest - same head-trimming rule as `trimLiveToCap`. Whole entries go first; an
 * entry that only partly fits is cut to its trailing rows (whole newline-separated segments from
 * the end, the last kept segment cut to its tail characters). Returns the input copy unchanged
 * when it already fits.
 */
export function trimLiveToRows(live: readonly string[], maxRows: number, cols: number): string[] {
  const budget = Math.max(1, maxRows);
  const c = Math.max(1, cols);
  let used = 0;
  const kept: string[] = [];
  for (let i = live.length - 1; i >= 0; i--) {
    const entry = live[i];
    const rows = rowsFor(entry, c);
    if (used + rows <= budget) {
      kept.push(entry);
      used += rows;
      continue;
    }
    // Partial fit: take trailing segments while they fit, then a tail slice of the next one.
    const left = budget - used;
    if (left > 0) {
      const segs = entry.split('\n');
      const tail: string[] = [];
      let r = 0;
      for (let j = segs.length - 1; j >= 0 && r < left; j--) {
        const segRows = Math.max(1, Math.ceil(segs[j].length / c));
        if (r + segRows <= left) {
          tail.unshift(segs[j]);
          r += segRows;
        } else {
          tail.unshift(segs[j].slice(-((left - r) * c)));
          r = left;
        }
      }
      kept.push(tail.join('\n'));
    }
    break;
  }
  return kept.reverse();
}

/** Applies both live-region bounds: characters always, rows when the state carries a row cap. */
function boundLive(live: readonly string[], state: TextWindowState, cap: number): string[] {
  const byChars = trimLiveToCap(live, cap);
  if (state.liveCapRows === undefined || state.liveCols === undefined) return byChars;
  return trimLiveToRows(byChars, state.liveCapRows, state.liveCols);
}

/** `blocks` lets `/resume` seed a window that already has content (a restored session's
 * formatted history) - `nextId` picks up after the highest id already in use, so ids stay unique
 * even when starting from a non-empty list rather than always starting from 0. */
export function initialTextWindow(
  blocks: readonly TextBlock[] = [],
  liveCapChars: number = DEFAULT_LIVE_CAP_CHARS,
  liveCapRows?: number,
  liveCols?: number,
): TextWindowState {
  const nextId = blocks.reduce((max, b) => Math.max(max, b.id + 1), 0);
  return { blocks, live: [], nextId, deltaActive: false, liveCapChars, liveCapRows, liveCols };
}

export function makeBlock(id: number, lines: Line[]): TextBlock {
  return { id, lines };
}

export function textWindowReducer(state: TextWindowState, action: TextWindowAction): TextWindowState {
  // `?? DEFAULT` guards state objects built before `liveCapChars` existed (tests' own literals);
  // a missing cap must degrade to the default budget, never to a NaN trim.
  const cap = state.liveCapChars ?? DEFAULT_LIVE_CAP_CHARS;
  switch (action.type) {
    case 'commit': {
      if (action.lines.length === 0) return state;
      return {
        ...state,
        blocks: [...state.blocks, { id: state.nextId, lines: action.lines, ...(action.flow ? { flow: true } : {}) }],
        nextId: state.nextId + 1,
      };
    }
    case 'setLiveTail': {
      if (action.text === '') return state.live.length === 0 && !state.deltaActive ? state : { ...state, live: [], deltaActive: false };
      // Bounded like any other live content: one unfinished line can still be longer than the
      // screen (a model writing a whole paragraph before its first newline), and the frame has to
      // stay under the viewport either way.
      return { ...state, live: boundLive([action.text], state, cap), deltaActive: false };
    }
    case 'setLiveCaps': {
      const next = { ...state, liveCapChars: action.liveCapChars, liveCapRows: action.liveCapRows, liveCols: action.liveCols };
      return { ...next, live: boundLive(state.live, next, action.liveCapChars) };
    }
    case 'appendLive':
      return { ...state, live: boundLive([...state.live, action.text], state, cap), deltaActive: false };
    case 'appendDelta': {
      if (action.startNewLine || state.live.length === 0 || !state.deltaActive) {
        return { ...state, live: boundLive([...state.live, action.text], state, cap), deltaActive: true };
      }
      const live = state.live.slice();
      live[live.length - 1] += action.text;
      return { ...state, live: boundLive(live, state, cap), deltaActive: true };
    }
    case 'updateScanSummary':
      return {
        ...state,
        live: boundLive([...state.live.filter((l) => !l.startsWith(SCAN_SUMMARY_PREFIX)), action.text], state, cap),
        deltaActive: false,
      };
    case 'clearLive':
      return state.live.length === 0 && !state.deltaActive ? state : { ...state, live: [], deltaActive: false };
    case 'reset':
      return initialTextWindow(action.blocks, cap, state.liveCapRows, state.liveCols);
    default:
      return state;
  }
}

