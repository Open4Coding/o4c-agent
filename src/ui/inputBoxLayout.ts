import wrapAnsi from 'wrap-ansi';

/**
 * Multi-line-aware cursor row/column math for `InputBox`'s Home/End/Up/Down movement.
 *
 * `value` may contain real embedded `\n` characters (inserted via Ctrl+J/Alt+Enter/a
 * Kitty-reported Enter combo - see docs/plans/0001.FrontEndIDEChanges.plan.md #4a) in addition
 * to soft-wrapping at `width` within each logical line.
 *
 * **Word-wrap, not hard-wrap** (as of the fix for David's "words get split in the middle"
 * report): earlier (#4) this module used a closed-form `floor(pos/width)` formula, which only
 * matched Ink's rendering when `<Text wrap="hard">` broke every row at *exactly* N characters
 * with no regard for word boundaries - exact, but it sliced words apart mid-character on
 * anything longer than one row (e.g. a long pasted line). Switched `InputBox.tsx` to
 * `wrap="wrap"` (word-wrap) instead, which meant this module could no longer get away with a
 * closed-form row formula - word-wrap's row boundaries depend on where spaces actually fall, not
 * a fixed character count. Instead of re-deriving an approximation of `wrap-ansi`'s own
 * algorithm, this module now calls `wrap-ansi` itself (the exact same library, same options,
 * that Ink's `wrap="wrap"` calls internally - confirmed in `node_modules/ink/build/
 * wrap-text.js`) and walks its actual output, which is correct by construction rather than by
 * approximation. Confirmed empirically (not assumed) that `{ trim: false, hard: true, wordWrap:
 * true }` never drops characters - a space that doesn't fit at a row boundary lands on its own
 * row rather than being discarded - so summing real row lengths is a lossless way to map
 * absolute text positions to row/column and back.
 *
 * The box's `prompt` is only ever rendered once, at the very start of logical line 0 - it isn't
 * repeated on continuation lines - so line 0's own wrapped rows come from wrapping
 * `prompt + line0Text` together, while every other logical line wraps its own text alone.
 */

export interface CursorPosition {
  /** Which logical line (0-based, split on '\n') the cursor is in. */
  line: number;
  /** Column within that logical line's own text - not wrap-width-relative. */
  col: number;
}

export interface VisualRow {
  line: number;
  /** Which wrapped row within `line` (0-based). */
  rowInLine: number;
  /** Column within that wrapped row. */
  colInRow: number;
}

/** Absolute cursor index (into `value`) -> which logical line and column within it. */
export function toLineCol(value: string, cursor: number): CursorPosition {
  const lines = value.split('\n');
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (cursor <= consumed + lineLen) {
      return { line: i, col: cursor - consumed };
    }
    consumed += lineLen + 1; // +1 for the '\n' separator
  }
  const lastLine = lines.length - 1;
  return { line: lastLine, col: lines[lastLine].length };
}

/** Inverse of `toLineCol` - clamps both `line` and `col` into range, so callers never need to
 * pre-clamp a computed target themselves. */
export function toCursor(value: string, pos: CursorPosition): number {
  const lines = value.split('\n');
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  let consumed = 0;
  for (let i = 0; i < line; i++) consumed += lines[i].length + 1;
  const col = Math.max(0, Math.min(pos.col, lines[line].length));
  return consumed + col;
}

/** The real wrapped rows of one logical line's own text (word-wrapped, `\n`-free by
 * construction - `wrap-ansi` never introduces one) - the same call Ink's `wrap="wrap"` makes
 * internally, so this is authoritative, not approximated. An empty string still yields one
 * (empty) row - confirmed against `wrap-ansi` directly - matching `resizeReflowFix.ts`'s own
 * measureFrame convention that an empty line still occupies one row. */
function wrapLine(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, width), { trim: false, hard: true, wordWrap: true }).split('\n');
}

/** This logical line's own wrap unit - `prompt + text` for line 0 (the prompt is line 0's
 * leading content for wrapping purposes), the line's own text alone for every other line. */
function unitTextFor(lineIndex: number, lineText: string, prompt: string): string {
  return lineIndex === 0 ? prompt + lineText : lineText;
}

/** A position within a logical line's own text -> the matching position within its wrap unit
 * (i.e. offset by the prompt's length, for line 0 only). */
function unitPosFor(lineIndex: number, col: number, prompt: string): number {
  return lineIndex === 0 ? prompt.length + col : col;
}

/** Which row (within `rows`) and column within that row a position falls on, walking real row
 * lengths rather than assuming a fixed width per row. A position exactly at a row boundary
 * (a row that's completely full) belongs to the *next* row, not the end of the current one - the
 * character actually rendered at that position (in inverse video, as the cursor cell) is the
 * next row's own first character, so that's genuinely where the cursor visually sits. Only the
 * true end of the *last* row (nothing left to spill into) lands there instead. */
function positionInRows(rows: string[], pos: number): { row: number; col: number } {
  let consumed = 0;
  for (let r = 0; r < rows.length; r++) {
    const len = rows[r].length;
    const isLastRow = r === rows.length - 1;
    if (pos < consumed + len || (isLastRow && pos <= consumed + len)) {
      return { row: r, col: pos - consumed };
    }
    consumed += len;
  }
  const last = rows.length - 1;
  return { row: last, col: rows[last].length };
}

/** Inverse of `positionInRows` - clamps both `row` and `col` into range. */
function positionFromRows(rows: string[], row: number, col: number): number {
  const r = Math.max(0, Math.min(row, rows.length - 1));
  let consumed = 0;
  for (let i = 0; i < r; i++) consumed += rows[i].length;
  return consumed + Math.max(0, Math.min(col, rows[r].length));
}

/** Which wrapped row/column the cursor currently sits on, within its own logical line. */
export function toVisualRow(value: string, cursor: number, width: number, prompt: string): VisualRow {
  const lines = value.split('\n');
  const { line, col } = toLineCol(value, cursor);
  const rows = wrapLine(unitTextFor(line, lines[line], prompt), width);
  const { row, col: colInRow } = positionInRows(rows, unitPosFor(line, col, prompt));
  return { line, rowInLine: row, colInRow };
}

/** Converts a wrap-unit position back into that logical line's own text-column, clamping for
 * line 0's prompt offset (a target that lands within the prompt itself has no valid text
 * position, so it clamps to the line's own start). */
function unitPosToCol(lineIndex: number, unitPos: number, prompt: string): number {
  return Math.max(0, lineIndex === 0 ? unitPos - prompt.length : unitPos);
}

/**
 * Up/down-arrow movement: moves within the current logical line's own wrapped rows first; only
 * once already on that line's topmost (up) or bottommost (down) row does it cross into the
 * previous/next logical line's own last/first row - and only once already on the very first
 * logical line (up) or very last logical line (down) does it return `undefined`, telling the
 * caller (InputBox's kill-ring yank / submit-history recall) that there's nowhere further to go
 * within the text itself. Column preservation and clamping-to-a-shorter-row both come directly
 * from `positionFromRows`, since it walks each row's own *real* length rather than assuming one.
 */
export function moveVisualRow(
  value: string,
  cursor: number,
  width: number,
  prompt: string,
  direction: 'up' | 'down',
): number | undefined {
  const lines = value.split('\n');
  const { line, col } = toLineCol(value, cursor);
  const rows = wrapLine(unitTextFor(line, lines[line], prompt), width);
  const { row: rowInLine, col: colInRow } = positionInRows(rows, unitPosFor(line, col, prompt));

  if (direction === 'up') {
    if (rowInLine > 0) {
      const targetUnitPos = positionFromRows(rows, rowInLine - 1, colInRow);
      return toCursor(value, { line, col: unitPosToCol(line, targetUnitPos, prompt) });
    }
    if (line === 0) return undefined;
    const prevLine = line - 1;
    const prevRows = wrapLine(unitTextFor(prevLine, lines[prevLine], prompt), width);
    const targetUnitPos = positionFromRows(prevRows, prevRows.length - 1, colInRow);
    return toCursor(value, { line: prevLine, col: unitPosToCol(prevLine, targetUnitPos, prompt) });
  }

  if (rowInLine < rows.length - 1) {
    const targetUnitPos = positionFromRows(rows, rowInLine + 1, colInRow);
    return toCursor(value, { line, col: unitPosToCol(line, targetUnitPos, prompt) });
  }
  if (line === lines.length - 1) return undefined;
  const nextLine = line + 1;
  const nextRows = wrapLine(unitTextFor(nextLine, lines[nextLine], prompt), width);
  const targetUnitPos = positionFromRows(nextRows, 0, colInRow);
  return toCursor(value, { line: nextLine, col: unitPosToCol(nextLine, targetUnitPos, prompt) });
}

/** Home: jump to the start of the cursor's current wrapped row, never crossing into a different
 * logical line (David: "home and end should move to the home and end of the line" - for a real
 * multi-line box that means the current paragraph's current visual row, not a different one). */
export function rowStart(value: string, cursor: number, width: number, prompt: string): number {
  const lines = value.split('\n');
  const { line, col } = toLineCol(value, cursor);
  const rows = wrapLine(unitTextFor(line, lines[line], prompt), width);
  const { row } = positionInRows(rows, unitPosFor(line, col, prompt));
  const targetUnitPos = positionFromRows(rows, row, 0);
  return toCursor(value, { line, col: unitPosToCol(line, targetUnitPos, prompt) });
}

/** End: jump to the end of the cursor's current wrapped row (or the logical line's own end, if
 * that row is its last and only partially filled) - same "never crosses lines" rule as `rowStart`. */
export function rowEnd(value: string, cursor: number, width: number, prompt: string): number {
  const lines = value.split('\n');
  const { line, col } = toLineCol(value, cursor);
  const rows = wrapLine(unitTextFor(line, lines[line], prompt), width);
  const { row } = positionInRows(rows, unitPosFor(line, col, prompt));
  const targetUnitPos = positionFromRows(rows, row, rows[row].length);
  return toCursor(value, { line, col: unitPosToCol(line, targetUnitPos, prompt) });
}
