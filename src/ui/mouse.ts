/**
 * Mouse click places the cursor (plan 0006 E16) - opt-in, `/set-mouse`, off by default.
 *
 * Why off by default: a terminal that reports the mouse to an app reports the wheel too, so while
 * it is on the wheel no longer scrolls back through the conversation, and plain drag-to-select
 * becomes Shift+drag (Windows Terminal, iTerm2, xterm, GNOME Terminal and kitty all honour Shift).
 * Turned on, it is only on while the input box is active, and always turned off on exit.
 *
 * How a click becomes a cursor position without knowing where the box is on screen: the input box
 * already parks the terminal's real cursor on its caret (`useCursor`), so on a click o4c asks the
 * terminal where its cursor is (`ESC[6n`). Click minus caret is a row/column offset from the caret,
 * which the box's own layout turns into a position in the text.
 *
 * Ink reads stdin with `read()`, and drops both mouse reports and cursor-position replies as keys
 * it cannot represent - so they never reach the input as text. To see them, `tapStdin` wraps
 * `read()` and looks at each chunk before handing it on unchanged (a second 'data' listener would
 * switch the stream to flowing mode and steal input from Ink).
 */
const ESC = String.fromCharCode(27);

export const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
export const MOUSE_OFF = `${ESC}[?1000l${ESC}[?1006l`;
export const ASK_CURSOR = `${ESC}[6n`;
export const MOUSE_CONFIG_KEY = 'mouse';

export interface MouseEvent {
  button: number;
  /** 1-based terminal column and row. */
  x: number;
  y: number;
  press: boolean;
}

const SGR_MOUSE = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g');
const CURSOR_REPORT = new RegExp(`${ESC}\\[(\\d+);(\\d+)R`);

export function parseSgrMouse(chunk: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const m of chunk.matchAll(SGR_MOUSE)) {
    out.push({ button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === 'M' });
  }
  return out;
}

/** A plain left-button press - not a drag (32), wheel (64+) or a modified click. */
export function isLeftClick(e: MouseEvent): boolean {
  return e.press && e.button === 0;
}

export function parseCursorReport(chunk: string): { row: number; col: number } | undefined {
  const m = CURSOR_REPORT.exec(chunk);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : undefined;
}

type Readable = NodeJS.ReadableStream & { read: (size?: number) => string | Buffer | null };

/** Calls `onChunk` with each chunk `stdin.read()` returns; the chunk itself passes through untouched. */
export function tapStdin(stdin: NodeJS.ReadableStream, onChunk: (chunk: string) => void): () => void {
  const s = stdin as unknown as Readable;
  const original = s.read;
  const tapped = function (this: Readable, size?: number) {
    const chunk = original.call(this, size);
    if (chunk !== null) {
      try {
        onChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      } catch {
        // A tap must never break input.
      }
    }
    return chunk;
  };
  s.read = tapped as Readable['read'];
  return () => {
    if (s.read === tapped) s.read = original;
  };
}
