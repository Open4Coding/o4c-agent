import type { LineKind } from './types.js';

/**
 * Amber-terminal color palette, ported from Hermes Agent's own Ink TUI
 * (`ui-tui/src/theme.ts`'s `DARK_SEEDS`) - truecolor hex values, not the terminal's own ANSI
 * scheme, so this renders the same regardless of the host terminal's color settings (per direct
 * instruction, matching the look from Hermes's screenshot).
 */
export const theme = {
  bg: '#101014',
  text: '#FFF8DC',
  accent: '#FFBF00',
  primary: '#FFD700',
  border: '#CD7F32',
  warn: '#ffa726',
  error: '#ef5350',
  ok: '#4caf50',
  /**
   * The user's own turn, and the only non-amber token in the palette. Added 2026-10-11 because a
   * `[user]` block rendered in `accent` - exactly what `[response]` renders in - so scrolling back
   * through a long transcript gave no way to find where a turn began. Green is the one hue that is
   * clearly not part of an amber scheme, so the eye finds it without reading. The value is sampled
   * from Claude Code's own terminal output (the dominant text color of David's screenshot, 12,853
   * pixels against the next-largest group's 4,291, which are its antialiasing), per his request to
   * match that green rather than pick a new one.
   */
  user: '#6AA167',
  /**
   * Tool calls and their results. Added 2026-10-11 at David's request ("can we do [tool] use as a
   * dimmed down white?"). They used to draw in `border`, the bronze also used for `system`, which
   * put the loudest-volume lines in the transcript - every call plus every result - in a saturated
   * amber competing with `accent`. This is literally `text` dimmed: #FFF8DC scaled to 65%, so it
   * reads as the theme's own white turned down rather than as a new hue, and recedes behind the
   * response and the user's turn where it belongs.
   *
   * Lightened from 65% to 80% (#A6A18F -> #CCC6B0) the same day, on sight: at 65% it had gone past
   * receding into hard to read, which is the wrong trade for lines carrying tool arguments and
   * output somebody actually needs to scan.
   */
  tool: '#CCC6B0',
} as const;

/**
 * How each kind of transcript line is drawn. One map rather than a switch in `App.tsx` so the
 * palette and its application live together - and so the color of a line kind is a value a test
 * can read, since Ink emits no escape codes under the test renderer (`ink-testing-library`
 * frames come back as plain text, so a rendered frame cannot be asserted on for color).
 */
export const lineStyle: Record<LineKind, { color: string; bold?: boolean }> = {
  system: { color: theme.border },
  user: { color: theme.user, bold: true },
  tool_call: { color: theme.tool },
  tool_result: { color: theme.tool },
  final: { color: theme.accent, bold: true },
  error: { color: theme.error },
  splash: { color: theme.primary, bold: true },
};
