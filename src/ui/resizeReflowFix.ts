import stringWidth from 'string-width';
import { appendFileSync } from 'node:fs';

const CSI = '\x1B[';
const ERASE_LINE = `${CSI}2K`;
const CURSOR_UP_ONE = `${CSI}1A`;

/**
 * TEMPORARY diagnostic instrumentation, 2026-09-30 - real user report that the screen still
 * clears/loses content on real long runs even with the scroll-instead-of-bail-out fix in place.
 * No repro available on this machine to test against directly, and the existing AgentEvent-level
 * run logs don't capture the raw bytes this module actually writes to the terminal - so there is
 * currently no way to tell whether this module's own logic is firing (and doing the wrong thing)
 * or not firing at all for whatever the real trigger is. Gated behind an env var, same pattern
 * already used successfully earlier in this project for the original tall-viewport bug
 * (`O4C_REFLOW_DEBUG_FILE`) - true zero-cost when unset (a single string check per write, no
 * file I/O), and meant to be removed once a real occurrence is actually captured and diagnosed.
 * Never throws into the render path - a failed diagnostic write must not break the actual fix.
 */
const REFLOW_DEBUG_FILE = process.env.O4C_REFLOW_DEBUG_FILE;
function debugLog(line: string): void {
  if (!REFLOW_DEBUG_FILE) return;
  try {
    appendFileSync(REFLOW_DEBUG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort only - see doc comment above
  }
}
/** Escapes control bytes so a logged chunk reads as one line of visible text, and caps its length
 * so one giant frame doesn't make the debug file unreadable - full raw length is still logged
 * separately as a number. */
function previewChunk(chunk: string): string {
  const escaped = chunk.replace(/\x1B/g, '\\x1B').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const max = 400;
  return escaped.length > max ? `${escaped.slice(0, max)}...(+${escaped.length - max} more)` : escaped;
}

/**
 * The bug this fixes, confirmed directly against Ink 5.2.1's source (log-update.js, ink.js):
 *
 * Ink repaints its live region by erasing the previous frame - it moves the cursor UP by the
 * number of `\n`-separated lines it last wrote, erasing each row - then writes the new frame.
 * That count is only right while every line still fits on one terminal row. When the terminal
 * gets NARROWER, the terminal itself reflows any line wider than the new width onto extra rows,
 * so the frame now occupies MORE rows than Ink's count. Ink's erase then stops short, and the
 * top of the old frame stays behind - stacked stale input boxes, spinner lines, mode lines, one
 * leftover per resize step. Widening is safe (a line never grows past the width it was wrapped
 * to), so this is purely a narrowing problem. Upstream considers it won't-fix
 * (github.com/vadimdemedes/ink issue #907), and Ink's own resize handler reacts to every raw
 * resize event, can't be suppressed, and can't be reordered from React.
 *
 * What this does instead, all from a plain pass-through wrapper on `stdout.write` (the one
 * choke point every Ink frame goes through, so it always knows exactly what's on screen):
 *
 * 1. While a resize is in progress, NOTHING is written. Every chunk Ink produces is held. On
 *    Windows the app doesn't draw to the terminal at all - it draws into conhost's buffer, which
 *    ConPTY re-renders to Windows Terminal, and both reflow independently during a drag. Measured
 *    on the real machine (D:\tmp\resize-probe.mjs): resize events arrive every ~33ms during a
 *    drag, and any frame written in between lands in a display that's mid-resync and leaves
 *    fragments that are invisible from the app's side and therefore unfixable after the fact.
 *    Frames that were correct when written were still getting shredded - so the only thing that
 *    works is to not write during the drag at all. "In progress" means: a 'resize' event landed
 *    less than `settleMs` ago, OR the console's live width (queried straight from the TTY handle,
 *    ahead of Node's cached `columns`) already disagrees with what Node last told Ink.
 *
 * 2. Once it settles, held chunks are replayed - and before each one that starts with Ink's
 *    erase prefix, the frame actually on screen is reconciled against what that chunk is about
 *    to assume: its reflowed row count (exact - Ink `trimEnd()`s every line, output.js - measured
 *    with string-width at the now-final width) versus the number of rows the chunk's own prefix
 *    is about to move up. If they differ, the on-screen frame is erased in place (cursor up to
 *    its true top, erase to end of screen, then newlines down to exactly where the chunk expects
 *    to start). Intermediate live frames that a later one supersedes are skipped; anything that
 *    is or belongs to a static commit (conversation history) is always replayed, in order, so
 *    nothing the model said during a drag is ever lost. The same reconcile also runs for normal
 *    (non-resize) writes, which is what makes skipping safe: a chunk's erase expectation comes
 *    from its own prefix, never from an assumption about the previous write.
 *
 * Things deliberately NOT done here, each tried in this codebase and found worse:
 * - Any full-screen clear (`ESC[2J`): on Windows Terminal and most modern terminals ED2 doesn't
 *   erase the viewport, it SCROLLS it into scrollback - every such clear archived the stale frame
 *   into history. That was "scroll up and the rewrites are still there".
 * - Remounting <Static> to re-wrap history: Static writes are permanent and additive, so a
 *   remount appends a second copy of the whole conversation every time.
 * - Swapping the live region for a placeholder plus a debounce, and correcting each frame as it
 *   is written: every transition still went through the same broken pipe mid-drag.
 *
 * Known residual limits:
 * - If the live region is taller than the visible viewport, part of the old frame is already in
 *   scrollback and can't be reached with an in-place erase - `reconcile()` detects this
 *   (`rows >= stdout.rows`) and, rather than attempting one (clamping the cursor at row 1 and
 *   wiping the whole viewport - confirmed live: this is what was actually happening, a real
 *   screen-blanking bug, not a harmless leftover), scrolls the stale frame's own true row count
 *   off the top in blank lines instead - always safe, since scrolling only ever moves rows into
 *   scrollback, never deletes them.
 * - The row math assumes the terminal REFLOWS wrapped lines on resize. Windows Terminal does
 *   (confirmed with the probe above - the cursor moved up exactly as lines unwrapped), as do
 *   iTerm2, Terminal.app, VTE/GNOME, kitty, Alacritty and tmux. xterm and legacy conhost do not
 *   (they clip), and there is no reliable way to detect which behaviour is active - the very
 *   reason upstream declined a similar fix (vadimdemedes/ink PR #916) and documented it as a
 *   known limitation instead (PR #920). On a non-reflowing terminal the old frame stays at one
 *   row per line, the erase here would over-count, and the cursor-up would walk into committed
 *   history. This project targets Windows Terminal, so that is accepted rather than guarded.
 */

/**
 * How many terminal rows a frame occupies once reflowed to `columns` wide (`rows`), versus how
 * many `\n`-lines it has (`lines`). `chunk` is the raw string as written - Ink's own leading
 * erase sequence plus the frame plus a trailing '\n'; string-width discards escape codes, so the
 * erase prefix on the first line measures as nothing.
 */
export function measureFrame(chunk: string, columns: number): { lines: number; rows: number } {
  const lines = chunk.split('\n');
  lines.pop(); // the trailing '\n' every frame ends with yields one empty tail element
  let rows = 0;
  for (const line of lines) rows += Math.max(1, Math.ceil(stringWidth(line) / columns));
  return { lines: lines.length, rows };
}

/**
 * How many rows a chunk's leading Ink erase prefix will move the cursor up before writing - i.e.
 * how many rows Ink believes the frame currently on screen occupies. The prefix is
 * `eraseLines(n)` from ansi-escapes: (eraseLine cursorUp) x (n-1), eraseLine, cursorLeft. Zero
 * for anything that doesn't start with an erase (a frame written right after a static commit, a
 * static chunk itself, cursor show/hide).
 *
 * Counts `cursorUp` occurrences, not `eraseLine` occurrences, deliberately - `n` here is
 * Ink's own real `previousLineCount`, which log-update.js computes as the frame's true content
 * line count *plus one* (confirmed directly, `resizeReflowFix.test.ts`'s own `inkFrame()` helper
 * and its "erase the previous frame (previousLineCount = its lines + 1...)" comment). Counting
 * `cursorUp`s (`n-1`) exactly cancels that "+1" back out, landing on the frame's real content-line
 * count - the same convention `measureFrame()` uses, which is what `reconcile()` actually compares
 * this against. Counting `eraseLine`s instead (tried and reverted - see git history) looks more
 * "literal" but breaks that cancellation and misaligns every reconcile check by one row.
 */
export function expectedUp(chunk: string): number {
  let i = 0;
  let up = 0;
  while (chunk.startsWith(ERASE_LINE, i)) {
    i += ERASE_LINE.length;
    if (!chunk.startsWith(CURSOR_UP_ONE, i)) break;
    i += CURSOR_UP_ONE.length;
    up += 1;
  }
  return up;
}

/** The bits of a TTY write stream this needs - structural so tests can use a plain mock. */
export interface ReflowFixableStream extends NodeJS.EventEmitter {
  columns?: number;
  rows?: number;
  write(chunk: unknown, ...rest: unknown[]): boolean;
}

/**
 * The terminal's width right now, straight from the OS - as opposed to `stdout.columns`, which
 * Node only refreshes when it processes the resize notification. Same handle call Node's own
 * `_refreshSize` makes; it's an internal, so it's feature-detected and simply unavailable (-> the
 * cached value is used) on anything that isn't a real TTY.
 */
function liveColumns(stdout: ReflowFixableStream): number | undefined {
  const handle = (stdout as { _handle?: { getWindowSize?: (out: number[]) => number } })._handle;
  if (typeof handle?.getWindowSize !== 'function') return undefined;
  const size = [0, 0];
  return handle.getWindowSize(size) === 0 && size[0] > 0 ? size[0] : undefined;
}

export interface ResizeReflowFixOptions {
  /** Quiet time after the last resize signal before held output is replayed. Resize events
   * arrive every ~33ms during a drag on Windows (measured), so this needs to clear that. */
  settleMs?: number;
}

/**
 * Installs the fix on `stdout`. Call BEFORE Ink's `render()` so the very first frame is seen.
 * Returns an uninstall function (flushes anything still held).
 */
export function installResizeReflowFix(
  stdout: ReflowFixableStream,
  { settleMs = 150 }: ResizeReflowFixOptions = {},
): () => void {
  debugLog(`--- installResizeReflowFix: columns=${stdout.columns} rows=${stdout.rows} settleMs=${settleMs} ---`);
  const originalWrite = stdout.write;
  const hadOwnWrite = Object.prototype.hasOwnProperty.call(stdout, 'write');
  const forward = (chunk: unknown, rest: unknown[]) => originalWrite.call(stdout, chunk, ...rest);

  let lastFrame: string | undefined;
  let frameOnScreen = false;
  let resizing = false;
  let held: Array<[unknown, unknown[]]> = [];
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  // Make the on-screen frame match what `chunk`'s own erase prefix is about to assume.
  const reconcile = (chunk: string) => {
    if (!frameOnScreen || lastFrame === undefined) {
      debugLog(`reconcile: skip (frameOnScreen=${frameOnScreen} lastFrame=${lastFrame !== undefined})`);
      return;
    }
    const columns = liveColumns(stdout) ?? stdout.columns;
    if (!columns) {
      debugLog('reconcile: skip (no columns available)');
      return;
    }
    const { rows } = measureFrame(lastFrame, columns);
    const expected = expectedUp(chunk);
    debugLog(
      `reconcile: columns=${columns} rows=${rows} expected=${expected} viewportRows=${stdout.rows} lastFrameLen=${lastFrame.length}`,
    );
    if (rows === expected) return; // Ink's own erase lands exactly on the frame
    // If the reflowed frame is at least as tall as the visible viewport, its top has already
    // scrolled out by the time this runs (writing its own trailing '\n' while sitting on the
    // last row necessarily scrolls the screen) - `${rows}A` can't reach it, ANSI just clamps the
    // cursor at row 1. Erasing from there to end-of-screen (`${CSI}J`) would then wipe the WHOLE
    // visible viewport, not just the stale frame - including any already-committed static history
    // currently showing above it, and with no ED2-style scrollback archive to recover it from
    // (confirmed live: a long turn with a tall live region blanked the entire scrollback down to
    // the input box).
    //
    // Real user report this closes, 2026-09-30: a plain bail-out here (do nothing, leave a "stale
    // remnant") was the original fix, but in practice this reads as the screen clearing/losing
    // content, not a harmless cosmetic leftover - confirmed as still happening on real long runs.
    // Scrolling is always safe (the terminal moves scrolled-past rows into scrollback, never
    // deletes them - the exact guarantee `ESC[2J` lacked and this module's own top-level doc
    // comment already rejected it for) - writing the stale frame's own true row count in blank
    // lines pushes it entirely off the top of the viewport. `expected` (Ink's own belief about
    // this same frame's height, ignoring reflow) can never exceed `rows` (the true, reflow-aware
    // height) - reflow only ever adds rows, never removes them - so this guarantees at least
    // `rows - expected >= 0` blank rows sit above the cursor afterward, meaning Ink's own
    // upcoming erase-and-rewrite (forwarded unmodified right after this returns) lands on that
    // blank space and paints correctly, instead of clamping at row 1 over whatever was there.
    const viewportRows = stdout.rows;
    if (viewportRows !== undefined && rows >= viewportRows) {
      debugLog(`reconcile: SCROLL branch - writing ${rows} blank lines (viewportRows=${viewportRows})`);
      forward('\n'.repeat(rows), []);
      frameOnScreen = false;
      return;
    }
    // Cursor sits just below the frame. Up to its true (reflowed) top, erase to the end of the
    // screen - only ever the live region, it's the last thing on screen - then newlines down to
    // exactly `expected` rows below the top, which is where the chunk is about to move up from.
    debugLog(`reconcile: CORRECTIVE-ERASE branch - ${CSI}${rows}A${CSI}J + ${expected} newlines`);
    forward(`${CSI}${rows}A${CSI}J${'\n'.repeat(expected)}`, []);
    frameOnScreen = false;
  };

  const emit = (chunk: unknown, rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      debugLog(`emit: non-string chunk (${typeof chunk})`);
      forward(chunk, rest);
      return;
    }
    const erases = chunk.startsWith(ERASE_LINE);
    debugLog(`emit: len=${chunk.length} erases=${erases} endsWithNL=${chunk.endsWith('\n')} chunk="${previewChunk(chunk)}"`);
    if (erases) reconcile(chunk);
    forward(chunk, rest);
    if (chunk.endsWith('\n')) {
      // A frame (live or static) - it's what's on screen now.
      lastFrame = chunk;
      frameOnScreen = true;
    } else if (erases) {
      // Erase-only (Ink's log.clear() before a static commit) - the frame is gone.
      frameOnScreen = false;
    }
  };

  const isFrame = (chunk: unknown): chunk is string =>
    typeof chunk === 'string' && chunk.startsWith(ERASE_LINE) && chunk.endsWith('\n');

  const settle = () => {
    settleTimer = undefined;
    resizing = false;
    const chunks = held;
    held = [];
    debugLog(`settle: replaying ${chunks.length} held chunks`);
    // Index of the last frame-shaped chunk in this batch, not the last array index - Ink 7 wraps
    // every frame in DEC synchronized-output toggles (`ESC[?2026h` before, `ESC[?2026l` after,
    // each its own separate stdout.write call), so the literal last queued item during a resize
    // drag is now that trailing `?2026l`, not the frame content. Using `i === chunks.length - 1`
    // as "is this superseded" misclassified the genuinely-final frame as skippable (it wasn't
    // last - the toggle after it was), so it got thrown away instead of ever reaching the screen.
    // Confirmed empirically: captured raw bytes on both sides of this module during a real
    // shrink-then-expand-back showed the correctly-sized final frame queued, then never once
    // appearing in what was actually written.
    let lastFrameIndex = -1;
    chunks.forEach(([chunk], i) => {
      if (isFrame(chunk)) lastFrameIndex = i;
    });
    chunks.forEach(([chunk, rest], i) => {
      // A live frame that a *later frame* supersedes never needs to reach the screen: the later
      // one's own erase prefix says what it expects, and reconcile matches the screen to that.
      // Everything else (erase-only, static, post-static, non-frame toggles, and the actual last
      // frame regardless of what non-frame bytes trail it) is replayed in order.
      if (isFrame(chunk) && i < lastFrameIndex) {
        return;
      }
      emit(chunk, rest);
    });
  };

  const beginResizing = () => {
    debugLog(`beginResizing: columns=${stdout.columns} rows=${stdout.rows} liveColumns=${liveColumns(stdout)}`);
    resizing = true;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, settleMs);
  };

  stdout.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    if (!resizing) {
      const live = liveColumns(stdout);
      if (live !== undefined && stdout.columns !== undefined && live !== stdout.columns) {
        // The terminal already changed size; Node's 'resize' event is on its way. Start holding
        // now rather than letting this one frame out into a display that's mid-resync.
        beginResizing();
      }
    }
    if (resizing) {
      held.push([chunk, rest]);
      return true;
    }
    emit(chunk, rest);
    return true;
  };

  // Prepended so it runs BEFORE Ink's own resize listener (registered at Ink's construction): the
  // repaint Ink does in that listener must be held like everything else during a drag.
  const onResize = () => beginResizing();
  stdout.prependListener('resize', onResize);

  return () => {
    stdout.off('resize', onResize);
    if (settleTimer) clearTimeout(settleTimer);
    resizing = false;
    for (const [chunk, rest] of held) forward(chunk, rest);
    held = [];
    if (hadOwnWrite) {
      stdout.write = originalWrite;
    } else {
      delete (stdout as { write?: unknown }).write;
    }
  };
}
