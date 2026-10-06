/**
 * How the live frame's height is divided between the parts that can grow.
 *
 * Ink writes the whole live region - streamed output, the input box, the status bar - as one frame,
 * and erases it with a relative cursor-up before writing the next. That only works while the frame
 * stays strictly below the viewport height: a frame as tall as the window scrolls its own top rows
 * into scrollback as it is written, and the next erase cannot reach them (ANSI clamps the cursor at
 * row 1), so the top of the old frame stays on screen and every repaint stacks another copy. The
 * local Ink patch clips frames at `viewportRows - 1` precisely because of this, and
 * `resizeReflowFix` documents the same limit from the other side.
 *
 * Two things in the frame can grow without bound, and until now each was bounded on its own: the
 * streamed live region (`textWindow`'s `liveCapRows`, which reserved "ten rows for the input box,
 * status bar and spinner") and, as of the bounded input box, the box itself. Two independent caps
 * that each assume the other stays small will happily sum past the viewport, so both now come from
 * here, from one set of numbers, and `frameBudget.test.ts` asserts their sum stays under the
 * viewport at every terminal height.
 *
 * Every function takes the row count rather than reading `process.stdout.rows` itself: the terminal
 * is resizable in both dimensions, so these are recomputed per render from the live size rather
 * than captured once at mount.
 */

/**
 * Rows the frame needs for everything that is neither the live region nor the box's own text: the
 * box's two border rows, the status bar, the keyboard-hint line, the thinking spinner, and
 * headroom for a palette or picker opening underneath. Deliberately generous - the cost of
 * over-reserving is a slightly shorter box, and the cost of under-reserving is the artifact this
 * whole module exists to prevent.
 */
export const FRAME_CHROME_ROWS = 10;

/** Most rows of text the input box will ever draw, however tall the terminal is. Past this a box
 * stops being an input box and should be an editor; it also keeps the live region's share of a
 * tall terminal from collapsing. */
export const MAX_INPUT_BOX_ROWS = 12;

/** Fewest rows of text the box draws, even on a terminal too short to afford them. Below this the
 * box cannot show a cursor in context at all. */
export const MIN_INPUT_BOX_ROWS = 3;

/**
 * Rows deliberately left unused at the bottom of the budget. "Fits the viewport" is not good
 * enough: a frame of exactly `rows` rows scrolls as its own last newline is written, which puts
 * its top row beyond the reach of the next erase - the same failure as a frame that overflows.
 * The budget therefore has to come out strictly under the viewport, and this is that margin.
 * Caught by `frameBudget.test.ts` at 15 rows, where the budgets summed to exactly 15.
 */
export const FRAME_SPARE_ROWS = 1;

/** Rows the streamed live region keeps even when the box is expanded over most of the screen. One
 * row of streamed output is little, but zero means a running turn draws nothing at all. */
export const MIN_LIVE_REGION_ROWS = 1;

/** Share of the screen an expanded box (Ctrl+O) may take. Requested directly: "do 80% of the
 * screen height". It is a target rather than a guarantee - on a short terminal the chrome and the
 * live region's own minimum are subtracted first, so the box gets whatever is left under that. */
export const EXPANDED_BOX_SCREEN_FRACTION = 0.8;

/**
 * Rows of text the input box may draw at this terminal height. At most a third of what is left
 * after chrome, so a tall paste can never crowd out the streamed output above it.
 */
export function inputBoxCapRows(rows: number | undefined): number {
  const height = rows ?? 30;
  const usable = Math.max(0, height - FRAME_CHROME_ROWS);
  return Math.max(MIN_INPUT_BOX_ROWS, Math.min(MAX_INPUT_BOX_ROWS, Math.floor(usable / 3)));
}

/**
 * Rows the streamed live region may occupy: whatever is left once chrome and the box's largest
 * possible share are accounted for. Never below one - on a terminal too short for the full budget
 * something has to give, and a single row of streamed output is more useful than none.
 */
export function liveRegionCapRows(rows: number | undefined): number {
  return liveRegionCapRowsFor(rows, inputBoxCapRows(rows));
}

/**
 * The most rows an expanded box may draw: 80% of the screen, or whatever is left once chrome, the
 * spare row and the live region's own minimum are taken out - whichever is smaller. On a tall
 * terminal the 80% target wins; on a short one the subtraction does, which is the point. Taking
 * literally 80% of a 30-row terminal would leave nothing for the status bar, let alone a frame that
 * still has to come out under the viewport.
 */
export function expandedInputBoxCapRows(rows: number | undefined): number {
  const height = rows ?? 30;
  const target = Math.floor(height * EXPANDED_BOX_SCREEN_FRACTION);
  const ceiling = height - FRAME_CHROME_ROWS - FRAME_SPARE_ROWS - MIN_LIVE_REGION_ROWS;
  return Math.max(MIN_INPUT_BOX_ROWS, Math.min(target, ceiling));
}

/**
 * The live region's share given whatever the box is currently taking. Expanding the box has to
 * shrink the live region by the same amount or the two together push the frame past the viewport -
 * the box is only expanded while composing, but a turn can still be streaming underneath it.
 */
export function liveRegionCapRowsFor(rows: number | undefined, boxCapRows: number): number {
  const height = rows ?? 30;
  return Math.max(MIN_LIVE_REGION_ROWS, height - FRAME_CHROME_ROWS - boxCapRows - FRAME_SPARE_ROWS);
}

/** Character budget matching `liveRegionCapRows` - the row bound alone can't bound memory, and the
 * character bound alone can't bound rows (many short lines span far more rows than chars/cols). */
export function liveRegionCapChars(rows: number | undefined, columns: number | undefined): number {
  return Math.max(800, liveRegionCapRows(rows) * (columns ?? 80));
}
