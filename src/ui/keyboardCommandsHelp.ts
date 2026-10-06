/**
 * Data and rendering for the `/keyboardcommands` command - a local, display-only reference for
 * the input box's keybindings and how their terminal/OS support varies. Never touches
 * `AgentLoop`/`loop.run()` at all (same as `/context`), so nothing here is ever sent to the
 * model or added to conversation history - it's pushed straight into App.tsx's own on-screen
 * `history`, which is a separate, UI-only concern from what actually reaches the LLM.
 *
 * Grounded in this project's own confirmed findings (docs/plans/0001.FrontEndIDEChanges.plan.md
 * #3/#4/#4a/#19), not assumed from a spec - see `src/ui/InputBox.tsx` for the actual behavior
 * each row describes.
 */
import { detectKittyLikeSupport, describeKittyLikeSupport } from './terminalCapabilities.js';
import { detectCurrentOs, type OsKey } from './platform.js';
import { OS_KEYBOARD_NOTES } from './osKeyboardNotes.js';

interface KeyboardCommandRow {
  keys: string;
  action: string;
  availability: string;
}

// Kept deliberately terse - an early draft with full sentences produced a table over 170
// columns wide, which wraps illegibly (box-drawing included) on any normal-width terminal. This
// version stays under ~110 columns total.
const ROWS: KeyboardCommandRow[] = [
  { keys: 'Enter', action: 'Submit message', availability: 'All terminals' },
  { keys: 'Ctrl+J', action: 'Insert newline', availability: 'All terminals' },
  {
    keys: 'Alt+Enter',
    action: 'Insert newline',
    // Confirmed by David on a real Windows Terminal/PowerShell session: Windows Terminal's
    // *default* keybindings bind Alt+Enter to toggleFullscreen (F11 is the alternate) and
    // intercept it before it ever reaches this process's stdin - Ink never even sees those
    // bytes, so there's nothing for InputBox.tsx to parse differently. Not a bug here; the
    // terminal itself owns the combo. Rebindable in Windows Terminal's own keybindings if
    // Alt+Enter-for-newline is wanted there instead.
    availability: 'Avoid on Windows Terminal (toggles fullscreen instead)',
  },
  {
    keys: 'Ctrl+Enter / Shift+Enter',
    action: 'Insert newline',
    // Placeholder - overwritten per-render in renderKeyboardCommandsTable() with a live-detected
    // value (see terminalCapabilities.ts). Kept here so ROWS stays a single source of row order.
    availability: 'Kitty terminals only (else: plain Enter)',
  },
  { keys: 'Escape', action: 'Cancel current turn', availability: 'While "Thinking..." is showing' },
  { keys: 'Ctrl+C', action: 'Disabled - no effect', availability: 'Use /exit instead' },
  { keys: '← / →', action: 'Move cursor', availability: 'All terminals' },
  { keys: '↑ / ↓', action: 'Move in line; browse history at edge', availability: 'All terminals' },
  { keys: 'Home / End', action: 'Jump to start/end of current line', availability: 'All terminals' },
  { keys: 'Ctrl+A / Ctrl+E', action: 'Jump to start/end of whole input', availability: 'All terminals' },
  { keys: 'Backspace', action: 'Delete char before cursor', availability: 'All terminals' },
  { keys: 'Ctrl+U / Ctrl+O', action: 'Kill to cursor (↑ yanks back) / expand collapsed pastes', availability: 'All terminals' },
  { keys: 'PgUp / PgDn', action: 'Move a windowful through a long input', availability: 'All terminals' },
  { keys: 'Ctrl+P / Ctrl+N', action: 'Jump to previous/next paragraph (also Ctrl+↑/↓ where supported)', availability: 'All terminals' },
  { keys: 'Tab', action: 'Cycle input mode', availability: 'All terminals' },
  { keys: '/', action: 'Open command palette', availability: 'All terminals' },
];

const HEADERS: [string, string, string] = ['Keys', 'Action', 'Availability'];

function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

function renderTable(env: NodeJS.ProcessEnv): string {
  const kittySupport = describeKittyLikeSupport(detectKittyLikeSupport(env));
  const rows = ROWS.map((r) =>
    r.keys === 'Ctrl+Enter / Shift+Enter' ? { ...r, availability: kittySupport } : r,
  );

  const widths = HEADERS.map((header, i) =>
    Math.max(header.length, ...rows.map((r) => [r.keys, r.action, r.availability][i].length)),
  );

  const rule = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;

  const formatRow = (cells: [string, string, string]): string =>
    '│ ' + cells.map((cell, i) => padEnd(cell, widths[i])).join(' │ ') + ' │';

  const lines = [
    rule('╭', '┬', '╮'),
    formatRow(HEADERS),
    rule('├', '┼', '┤'),
    ...rows.map((r) => formatRow([r.keys, r.action, r.availability])),
    rule('╰', '┴', '╯'),
  ];

  return lines.join('\n');
}

function renderOsNotes(osKey: OsKey): string {
  const notes = OS_KEYBOARD_NOTES[osKey];
  const bulletList = (items: string[]): string => items.map((item) => `  - ${item}`).join('\n');

  return [
    `${notes.label} keyboard notes:`,
    '',
    'Safe:',
    bulletList(notes.safe),
    '',
    'Avoid:',
    bulletList(notes.avoid),
    '',
    'Notes:',
    bulletList(notes.notes),
    '',
    '(Other systems: /keyboardcommands windows|mac|linux)',
  ].join('\n');
}

/** Renders o4c-agent's own keybinding table (answers "what does this app do") plus a per-OS
 * bulleted block (answers "what will my OS/terminal intercept before this app even sees it") -
 * two different questions, kept as separate sections rather than merged into one table. One
 * plain string ready to push as a single `system` Line - the same "compute a plain multi-line
 * string, no LLM call" shape App.tsx's `/context` handler uses.
 *
 * `env` and `osKey` are injectable for tests only (default to `process.env`/`detectCurrentOs()`).
 * The Ctrl+Enter/Shift+Enter row's availability is computed live per-render from
 * `detectKittyLikeSupport()` rather than baked into `ROWS`, since it depends on the terminal the
 * app is actually running in. */
export function renderKeyboardCommandsHelp(
  env: NodeJS.ProcessEnv = process.env,
  osKey: OsKey = detectCurrentOs(),
): string {
  return [renderTable(env), renderOsNotes(osKey)].join('\n\n');
}
