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
   * Tool OUTPUT - the `[result]` lines. Added 2026-10-11 at David's request ("can we do [tool] use
   * as a dimmed down white?"). It used to draw in `border`, the bronze also used for `system`,
   * which put the loudest-volume lines in the transcript in a saturated amber competing with
   * `accent`. This is literally `text` dimmed: #FFF8DC scaled to 80%, so it reads as the theme's
   * own white turned down rather than as a new hue. (Started at 65% and was lightened the same
   * day, on sight: 65% had gone past receding into hard to read, which is the wrong trade for
   * output somebody actually needs to scan.)
   */
  tool: '#CCC6B0',
  /**
   * The tool CALL line - `[read_file] {...}`. Split off from `tool` 2026-10-11, same day, on
   * David's instruction: "I need [tool] to be bright white and the output to be the same color it
   * is." Pure white rather than `text`'s cornsilk, because bright was the whole request and the
   * warm white is a shade too close to the output it now has to stand apart from.
   *
   * The pairing is the point: the call is the thing you scan FOR when reading back a transcript,
   * and its output is bulk you read only once you have found the call. So the call leads at full
   * brightness and the output sits a step behind it, instead of both being one weight.
   */
  toolCall: '#FFFFFF',
} as const;

/**
 * How each kind of transcript line is drawn. One map rather than a switch in `App.tsx` so the
 * palette and its application live together - and so the color of a line kind is a value a test
 * can read, since Ink emits no escape codes under the test renderer (`ink-testing-library`
 * frames come back as plain text, so a rendered frame cannot be asserted on for color).
 */
/**
 * The context bar's two colours, as a function a test can read rather than a pair of ternaries
 * inline in the status line - same reasoning as `lineStyle` below: ink-testing-library strips
 * colour from its frames, so a rendered frame cannot be asserted on for colour.
 *
 * `pressureRatio` is a parameter rather than a constant here because the threshold belongs to the
 * engine (`CONTEXT_PRESSURE_RATIO` in agent/loop.ts) - the status line passes the engine's own
 * number in, so the bar cannot end up changing colour at a threshold nothing acts on. Front-end
 * checklist #13.
 */
export function contextBarStyle(
  fraction: number,
  pressureRatio: number,
): { bar: string; percent: string } {
  // At or above the line, where the loop starts pausing to compact before it will send.
  if (fraction >= pressureRatio) return { bar: theme.error, percent: theme.error };
  // Below it, the colours the bar has always had: the point is that 79% and 81% must not look
  // identical, not that ordinary usage should look alarming.
  return { bar: theme.warn, percent: theme.accent };
}

export const lineStyle: Record<LineKind, { color: string; bold?: boolean }> = {
  system: { color: theme.border },
  user: { color: theme.user, bold: true },
  tool_call: { color: theme.toolCall },
  tool_result: { color: theme.tool },
  final: { color: theme.accent, bold: true },
  error: { color: theme.error },
  splash: { color: theme.primary, bold: true },
};

/**
 * Syntax colours - checklist item 9. Monokai's hues, the scheme Claude Code's diff colours were
 * measured against: chosen for readability on a near-black background, and distinct from the amber
 * of the transcript chrome so code never reads as UI. Keys are highlight.js scopes; `scopeColor`
 * tries the full scope, then its first part.
 */
export const syntax: Readonly<Record<string, string>> = {
  keyword: '#F92672',
  'meta.keyword': '#F92672',
  operator: '#F92672',
  string: '#E6DB74',
  regexp: '#E6DB74',
  char: '#E6DB74',
  number: '#AE81FF',
  literal: '#AE81FF',
  symbol: '#AE81FF',
  comment: '#8F8B76',
  doc: '#8F8B76',
  quote: '#8F8B76',
  title: '#A6E22E',
  section: '#A6E22E',
  'title.class': '#66D9EF',
  type: '#66D9EF',
  built_in: '#66D9EF',
  attr: '#FD971F',
  params: '#FD971F',
  attribute: '#A6E22E',
  property: '#F8F8F2',
  variable: '#F8F8F2',
  'variable.language': '#FD971F',
  meta: '#8F8B76',
  tag: '#F92672',
  name: '#F92672',
  'selector-tag': '#F92672',
  'selector-class': '#A6E22E',
  'selector-id': '#A6E22E',
  addition: '#A6E22E',
  deletion: '#F92672',
};

/** The colour for a highlight.js scope, or `undefined` to leave the text in its default colour. */
export function scopeColor(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  return syntax[scope] ?? syntax[scope.split('.')[0]];
}

/**
 * Diff backgrounds - a whole changed line gets the dim one, the words that changed within it the
 * bright one. Dark enough that the syntax colours drawn on top keep their contrast.
 */
export const diffColors = {
  removedLine: '#3D1F1F',
  removedWord: '#7A2E2E',
  addedLine: '#1E3A22',
  addedWord: '#2F6B37',
  gutter: '#75715E',
} as const;
