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
} as const;
