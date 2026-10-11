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
}
