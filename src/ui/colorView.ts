import { theme } from './theme.js';
import { infoLine } from './labels.js';
import type { Line } from './types.js';

/**
 * `/colorview` - every color this UI can draw with, one per line, each line drawn in the color it
 * names. Asked for 2026-10-11, after the `[user]` block went green: the palette had never been
 * visible anywhere, so picking a color meant reading hex out of `theme.ts` and imagining it.
 *
 * A pure function returning `Line[]` rather than a component, for the same reason `lineStyle` is a
 * map: `ink-testing-library` renders with color OFF, so a test can assert what color a line
 * carries but never what a frame looks like.
 */

/** The sample text, left-aligned on every row so the eye compares colors down one column. */
export const SAMPLE_TEXT = 'Hello Have A Nice Day';

/**
 * The eight ANSI hues, in their standard code order (30-37 dark, 90-97 light). These are the
 * terminal's OWN palette slots - what `green` looks like is decided by the user's terminal theme,
 * which is exactly why `theme.ts` is truecolor hex instead. Shown here because they are available,
 * with that caveat printed under them rather than left to be rediscovered.
 */
export const ANSI_HUES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;

export type AnsiHue = (typeof ANSI_HUES)[number];

/** `red` -> `redBright`, the chalk name Ink forwards for the light half of a hue. */
export function brightName(hue: AnsiHue): string {
  return `${hue}Bright`;
}

function row(sample: string, tone: string, name: string, code: string, color: string): Line {
  return {
    kind: 'system',
    text: `  ${sample}   ${tone.padEnd(5)}   ${name.padEnd(15)}${code}`,
    color,
  };
}

/** Every named ANSI color, dark then light within each hue. 16 rows. */
export function ansiColorLines(): Line[] {
  const lines: Line[] = [];
  ANSI_HUES.forEach((hue, i) => {
    lines.push(row(SAMPLE_TEXT, 'dark', hue, `ansi ${30 + i}`, hue));
    lines.push(row(SAMPLE_TEXT, 'light', brightName(hue), `ansi ${90 + i}`, brightName(hue)));
  });
  return lines;
}

/**
 * Every token in this app's own palette, in `theme.ts` order. `bg`'s note goes in the trailing
 * column, not next to the sample: a longer sample wraps at narrow widths and breaks the one
 * column the chart exists to give you.
 */
export function themeColorLines(): Line[] {
  return Object.entries(theme).map(([name, hex]) =>
    row(SAMPLE_TEXT, 'theme', name, name === 'bg' ? `${hex}   (the background - this row is meant to vanish)` : hex, hex),
  );
}

/** The whole `/colorview` block: a header, both tables, and what is available beyond them. */
export function colorViewLines(): Line[] {
  const ansi = ansiColorLines();
  const tokens = themeColorLines();
  return [
    infoLine(
      [
        `Colors available to the UI: ${ansi.length} named (${ANSI_HUES.length} hues x dark/light), ` +
          `${tokens.length} theme tokens, 256 indexed (ansi256(0)-ansi256(255)), and any truecolor #RRGGBB.`,
        '',
        'Named terminal colors - drawn from YOUR terminal\'s theme, so these differ between terminals:',
      ].join('\n'),
    ),
    ...ansi,
    { kind: 'system', text: ' ' },
    {
      kind: 'system',
      text: 'Theme palette (theme.ts) - truecolor hex, identical in every terminal:',
    },
    ...tokens,
    { kind: 'system', text: ' ' },
    {
      kind: 'system',
      text: 'Also valid anywhere a color is set: ansi256(0)-ansi256(255), #RRGGBB, rgb(r, g, b).',
    },
  ];
}
