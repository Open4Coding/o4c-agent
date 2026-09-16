import stringWidth from 'string-width';

const CSI = '\x1B[';
const ERASE_LINE = `${CSI}2K`;
const CURSOR_UP_ONE = `${CSI}1A`;

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
 *   scrollback and can't be reached.
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
    if (!frameOnScreen || lastFrame === undefined) return;
    const columns = liveColumns(stdout) ?? stdout.columns;
    if (!columns) return;
    const { rows } = measureFrame(lastFrame, columns);
    const expected = expectedUp(chunk);
    if (rows === expected) return; // Ink's own erase lands exactly on the frame
    // Cursor sits just below the frame. Up to its true (reflowed) top, erase to the end of the
    // screen - only ever the live region, it's the last thing on screen - then newlines down to
    // exactly `expected` rows below the top, which is where the chunk is about to move up from.
    forward(`${CSI}${rows}A${CSI}J${'\n'.repeat(expected)}`, []);
    frameOnScreen = false;
  };

  const emit = (chunk: unknown, rest: unknown[]) => {
    if (typeof chunk !== 'string') {
      forward(chunk, rest);
      return;
    }
    const erases = chunk.startsWith(ERASE_LINE);
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

  const settle = () => {
    settleTimer = undefined;
    resizing = false;
    const chunks = held;
    held = [];
    chunks.forEach(([chunk, rest], i) => {
      const last = i === chunks.length - 1;
      // A live frame with an erase prefix that a later chunk supersedes never needs to reach the
      // screen: the next chunk's prefix says what it expects, and reconcile matches the screen to
      // that. Everything else (erase-only, static, post-static, and the final chunk) is replayed
      // in order.
      if (!last && typeof chunk === 'string' && chunk.startsWith(ERASE_LINE) && chunk.endsWith('\n')) {
        return;
      }
      emit(chunk, rest);
    });
  };

  const beginResizing = () => {
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
