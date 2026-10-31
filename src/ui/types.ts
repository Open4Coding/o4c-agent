import type { CodeLine } from './syntaxHighlight.js';

export type LineKind = 'system' | 'user' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'splash';

export interface Line {
  kind: LineKind;
  text: string;
  /**
   * Overrides the color `lineStyle[kind]` would give this line. Added 2026-10-11 for `/colorview`,
   * which has to draw each row in the color that row names - the only case so far where two lines
   * of the same kind are different colors. Display-only and not persisted: a line rebuilt from a
   * saved entry after a reload comes back in its kind's color, which for a color chart is a
   * one-command redraw.
   */
  color?: string;
  /**
   * A streamed reply line inside a fenced code block, with its syntax colours (item 9). Set at
   * commit time by `codeFences.ts`'s tracker, because a streamed line is committed before the
   * lines that would show it is code have arrived - the renderer cannot work it out on its own.
   * Display-only, like `color`: a reloaded session is redrawn from whole replies, which the
   * renderer colours itself.
   */
  code?: CodeLine;
  /** A streamed reply line that opens or closes a fenced block, drawn dim. Same lifetime as `code`. */
  fence?: boolean;
}
