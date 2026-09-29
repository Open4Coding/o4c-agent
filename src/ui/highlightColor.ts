import { theme } from './theme.js';

/**
 * The accepted values for the "/" palette highlight color - the single source of truth shared
 * by BOTH the write path (App.tsx's /config-highlightcolor handler) and the read path (cli.ts's
 * config.json load, via `resolveHighlightColor` below). A #RRGGBB hex code (theme.ts's own
 * convention) or one of Ink's/chalk's standard named colors. No attempt to validate every color
 * name chalk technically supports (e.g. "ansi256" numeric forms) - this is the same small,
 * practical set a terminal user would actually reach for.
 */
export const HIGHLIGHT_COLOR_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright',
  'cyanBright', 'whiteBright',
] as const;

export function isValidHighlightColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value) || (HIGHLIGHT_COLOR_NAMES as readonly string[]).includes(value);
}

/**
 * The read-path counterpart to `isValidHighlightColor`'s write-path validation.
 *
 * Closes a reproduced glitch (2026-09-27): cli.ts accepted ANY string from config.json's
 * `highlightColor` and threaded it straight into the pickers' `borderColor`/`color` props, but
 * Ink/chalk SILENTLY DROP an unrecognized color - verified at the byte level (a row styled with
 * e.g. "purple" emits the inverse SGR but NO color SGR at all). Since config.json is
 * hand-editable, a bad value (typo, or written by a different build) would strip the palette's
 * highlight styling with no error or warning anywhere in the app. The write path validates, so
 * the read path must too: anything invalid or non-string falls back to the theme's own accent
 * (what the UI already uses everywhere else) instead of being silently ignored downstream.
 */
export function resolveHighlightColor(raw: unknown, fallback: string = theme.accent): string {
  return typeof raw === 'string' && isValidHighlightColor(raw) ? raw : fallback;
}
