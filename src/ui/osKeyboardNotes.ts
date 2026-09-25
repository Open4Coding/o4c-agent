import type { OsKey } from './platform.js';

interface OsKeyboardNotes {
  label: string;
  safe: string[];
  avoid: string[];
  notes: string[];
}

// Plain, end-user phrasing on purpose - no file:line citations or GitHub issue numbers. That
// sourcing lives in docs/o4c-agent-design.md §2.1 and docs/keyboard-usage-<os>.md; this is a
// distilled in-app summary, not the research record.
const SAFE_BASELINE = [
  'Ctrl+A through Ctrl+Z - all work as normal input shortcuts',
  'Shift+Tab, arrow keys, Home/End, Page Up/Down - all work normally',
];

export const OS_KEYBOARD_NOTES: Record<OsKey, OsKeyboardNotes> = {
  windows: {
    label: 'Windows',
    safe: SAFE_BASELINE,
    avoid: [
      'Alt+anything - unreliable here; avoid relying on it',
      'Ctrl+Shift+letter/digit - reserved by Windows Terminal (copy/paste, tab-switching)',
      'Ctrl+Alt+letter - collides with AltGr on many non-US keyboard layouts',
      'Ctrl+V - reserved for system paste',
      'F1-F12, Ctrl+Fkey, Alt+Fkey - reserved/unreliable',
      'Ctrl+Backspace / Ctrl+Delete - no standard behavior, varies by terminal',
    ],
    notes: [
      "Alt+Enter toggles Windows Terminal's fullscreen instead of reaching this app",
      'Ctrl+Enter/Shift+Enter as a signal distinct from plain Enter is not reliable yet on Windows',
    ],
  },
  macos: {
    label: 'macOS',
    safe: SAFE_BASELINE,
    avoid: [
      'Option (Alt)+anything - types accented characters instead (e.g. Option+A -> å)',
      'Ctrl+Arrow - intercepted by macOS Mission Control (Spaces switching)',
      'Bare F1-F12 - hardware brightness/media keys by default',
      'Ctrl+Option+letter - reserved by VoiceOver as its main shortcut prefix',
      'Ctrl+Shift+combos - Mac terminals use Cmd, not Ctrl, as the primary shortcut modifier',
    ],
    notes: [
      'Shift+Enter as a signal distinct from plain Enter is unreliable specifically in Terminal.app',
      'Not yet verified on real Mac hardware - please report anything that does not work as expected',
    ],
  },
  linux: {
    label: 'Linux',
    safe: SAFE_BASELINE,
    avoid: [
      'Alt+anything - unreliable here; avoid relying on it',
      'Ctrl+Shift+letter/digit - reserved by most terminals (copy/paste, new tab)',
      'Ctrl+Alt+F1 through F7 - switches virtual terminals at the OS level',
      'Ctrl+Alt+letter - reserved by GNOME/KDE desktop window-management shortcuts',
    ],
    notes: ['Running under WSL behaves like its own environment - not quite Windows, not quite native Linux'],
  },
};

const ALIASES: Record<string, OsKey> = {
  windows: 'windows',
  win: 'windows',
  macos: 'macos',
  mac: 'macos',
  osx: 'macos',
  darwin: 'macos',
  linux: 'linux',
};

/** Case-insensitive; returns undefined for anything unrecognized so the caller can show a usage
 * error rather than silently falling back to a guess. */
export function parseOsArg(arg: string): OsKey | undefined {
  return ALIASES[arg.trim().toLowerCase()];
}
