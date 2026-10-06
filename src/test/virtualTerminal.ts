/**
 * A minimal VT model: replays the byte stream Ink actually writes and reports what the screen
 * would look like afterwards.
 *
 * Why this exists. Every test harness in this repo renders through `ink-testing-library`, whose
 * mock stdout has no concept of terminal ROWS, of scrolling, or of a line wrapping - it just keeps
 * the last string Ink handed it. That makes a whole class of bug invisible to the test suite: the
 * stacked copies of the input box left behind in scrollback. Those come from a mismatch between the
 * rows Ink BELIEVES the previous frame occupied (`previousLineCount`, which it erases with
 * `eraseLines`) and the rows the terminal ACTUALLY gave it. Nothing in a string-capturing mock can
 * see that mismatch, so between 2026-10-04 and 2026-10-05 four separate attempted fixes (cap the
 * box height, hold it at constant height during an animation, pad it, drop the animation) each had
 * to be shipped to David and tried by hand, and each failed - five live test cycles that produced
 * no mechanism, because there was nothing that could answer "does this stack?" offline.
 *
 * This answers it. Feed it the same chunks Ink wrote and it returns the visible grid; a test then
 * asserts the obvious thing - the screen holds exactly ONE input box, not six.
 *
 * Deliberately models only what Ink emits, and models it the way a real terminal behaves:
 *
 * - A `\t` advances the cursor to the next multiple of `TAB_STOP`. This is not a convenience: it is
 *   the whole reason the model is useful. `string-width` scores a tab as zero, so Ink under-counts
 *   a tab-carrying line's width, never wraps it, and the terminal spends an extra row on it - the
 *   exact desync that produced the artifacts. Modelling tabs honestly reproduces the bug here
 *   rather than hiding it.
 * - Writing past the last column wraps to the next row, and a newline on the last row scrolls the
 *   whole grid up. Scrolled-off rows move to `scrollback`, never vanish - matching a real terminal,
 *   and matching why `resizeReflowFix` prefers scrolling to `ESC[2J`.
 * - Cursor movement clamps at the edges instead of wrapping, which is what makes the "erase can't
 *   reach a frame whose top already scrolled away" case reproduce faithfully.
 */

import stringWidth from 'string-width';

const TAB_STOP = 8;

export interface VirtualTerminalOptions {
  columns?: number;
  rows?: number;
}

export class VirtualTerminal {
  readonly columns: number;
  readonly rows: number;
  /** Visible grid, one string per row, space-padded lazily (trailing spaces are trimmed on read). */
  private grid: string[];
  /** Rows that have scrolled off the top, oldest first. A real terminal keeps these; so do we. */
  readonly scrollback: string[] = [];
  private row = 0;
  private col = 0;

  constructor({ columns = 100, rows = 30 }: VirtualTerminalOptions = {}) {
    this.columns = columns;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => '');
  }

  /** The visible screen, top row first, with trailing blank rows and trailing spaces removed. */
  screen(): string[] {
    const lines = this.grid.map((line) => line.replace(/\s+$/, ''));
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines;
  }

  /** How many visible rows contain `needle`. The core assertion: one input box, not six. */
  countRowsContaining(needle: string): number {
    return this.screen().filter((line) => line.includes(needle)).length;
  }

  cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === '\x1B') {
        const consumed = this.escape(chunk, i);
        if (consumed > 0) {
          i += consumed;
          continue;
        }
        i += 1; // a lone ESC draws nothing
        continue;
      }
      if (ch === '\n') {
        this.lineFeed();
        i += 1;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === '\t') {
        // A tab moves the cursor to the next stop; it does not erase what it passes over.
        this.col = Math.min(this.columns, this.col + (TAB_STOP - (this.col % TAB_STOP)));
        if (this.col >= this.columns) {
          this.col = 0;
          this.lineFeed();
        }
        i += 1;
        continue;
      }
      if (ch < ' ' || ch === '\x7F') {
        i += 1; // any other control draws nothing
        continue;
      }
      this.put(ch);
      i += 1;
    }
  }

  /** Handles one escape sequence starting at `start`; returns how many characters it consumed. */
  private escape(chunk: string, start: number): number {
    const rest = chunk.slice(start);
    // CSI sequences: ESC [ <private?> <params> <final>
    const csi = /^\x1B\[([?]?)([0-9;]*)([A-Za-z])/.exec(rest);
    if (!csi) return 0;
    const [matched, priv, rawParams, final] = csi;
    const params = rawParams.split(';').map((p) => (p === '' ? undefined : Number(p)));
    const first = params[0];
    if (priv === '?') return matched.length; // cursor show/hide, synchronized output - no screen effect
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - (first ?? 1));
        break;
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + (first ?? 1));
        break;
      case 'C':
        this.col = Math.min(this.columns - 1, this.col + (first ?? 1));
        break;
      case 'D':
        this.col = Math.max(0, this.col - (first ?? 1));
        break;
      case 'G':
        this.col = Math.max(0, (first ?? 1) - 1);
        break;
      case 'H':
      case 'f':
        this.row = Math.min(this.rows - 1, Math.max(0, (first ?? 1) - 1));
        this.col = Math.min(this.columns - 1, Math.max(0, (params[1] ?? 1) - 1));
        break;
      case 'E':
        this.row = Math.min(this.rows - 1, this.row + (first ?? 1));
        this.col = 0;
        break;
      case 'F':
        this.row = Math.max(0, this.row - (first ?? 1));
        this.col = 0;
        break;
      case 'K':
        // 0/absent: to end of line. 1: to start. 2: whole line.
        if (first === 2) this.grid[this.row] = '';
        else if (first === 1) this.grid[this.row] = ' '.repeat(this.col + 1) + this.grid[this.row].slice(this.col + 1);
        else this.grid[this.row] = this.grid[this.row].slice(0, this.col);
        break;
      case 'J':
        // 0/absent: to end of screen. 1: to start. 2: whole screen - and note that a real terminal
        // SCROLLS the viewport into scrollback for ED2 rather than discarding it, which is exactly
        // why resizeReflowFix refuses to use it.
        if (first === 2) {
          for (const line of this.grid) if (line !== '') this.scrollback.push(line);
          this.grid = Array.from({ length: this.rows }, () => '');
        } else if (first === 1) {
          for (let r = 0; r < this.row; r++) this.grid[r] = '';
          this.grid[this.row] = ' '.repeat(this.col + 1) + this.grid[this.row].slice(this.col + 1);
        } else {
          this.grid[this.row] = this.grid[this.row].slice(0, this.col);
          for (let r = this.row + 1; r < this.rows; r++) this.grid[r] = '';
        }
        break;
      default:
        break; // SGR ('m') and anything else has no effect on layout
    }
    return matched.length;
  }

  private lineFeed(): void {
    if (this.row === this.rows - 1) {
      this.scrollback.push(this.grid[0]);
      this.grid.shift();
      this.grid.push('');
    } else {
      this.row += 1;
    }
    this.col = 0;
  }

  /** Writes one printable character at the cursor, wrapping (and scrolling) at the right margin. */
  private put(ch: string): void {
    const width = Math.max(1, stringWidth(ch));
    if (this.col + width > this.columns) {
      this.col = 0;
      this.lineFeed();
    }
    const line = this.grid[this.row].padEnd(this.col, ' ');
    this.grid[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + width);
    this.col += width;
  }
}
