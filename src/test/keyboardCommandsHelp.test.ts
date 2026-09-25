import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderKeyboardCommandsHelp } from '../ui/keyboardCommandsHelp.js';
import { detectKittyLikeSupport } from '../ui/terminalCapabilities.js';

test('renders a well-formed table: header, a rule under it, one row per binding, and aligned column widths', () => {
  const help = renderKeyboardCommandsHelp({}, 'windows');
  // The table is the first block, separated from the appended OS-notes block by a blank line.
  const table = help.split('\n\n')[0];
  const lines = table.split('\n');

  // Top border, header row, header/body divider, N body rows, bottom border.
  assert.ok(lines[0].startsWith('╭') && lines[0].endsWith('╮'));
  assert.ok(lines.at(-1)?.startsWith('╰') && lines.at(-1)?.endsWith('╯'));
  assert.ok(lines[1].includes('Keys') && lines[1].includes('Action') && lines[1].includes('Availability'));
  assert.ok(lines[2].startsWith('├') && lines[2].endsWith('┤'));

  // Every content line (not a border rule) is the same total width - proof the columns are
  // actually padded/aligned, not just concatenated.
  const contentLines = lines.filter((l) => l.startsWith('│'));
  const widths = new Set(contentLines.map((l) => l.length));
  assert.equal(widths.size, 1);
  assert.ok(contentLines.length > 10); // header + every documented binding
});

test('documents the keybindings this project actually confirmed, not a generic/assumed list', () => {
  const help = renderKeyboardCommandsHelp({}, 'windows');

  // Spot-check a representative sample from each part of the plan's own findings (#3/#4/#4a/#19)
  // - not exhaustive, just enough to catch the table silently drifting from InputBox.tsx's real
  // behavior.
  for (const needle of [
    'Ctrl+J',
    'Alt+Enter',
    'Ctrl+Enter',
    'Escape',
    'Ctrl+C',
    'Home / End',
    'Ctrl+U',
    'Tab',
  ]) {
    assert.ok(help.includes(needle), `expected the table to mention "${needle}"`);
  }
});

test('Ctrl+Enter/Shift+Enter availability reflects a live-detected kitty-like support heuristic, not a hardcoded string', () => {
  const unknown = renderKeyboardCommandsHelp({}, 'windows');
  assert.ok(unknown.includes('Unknown'));

  const likely = renderKeyboardCommandsHelp({ KITTY_WINDOW_ID: '1' }, 'windows');
  assert.ok(likely.includes('Likely supported'));
  assert.ok(!likely.includes('Unknown'));

  const unlikely = renderKeyboardCommandsHelp({ TERM_PROGRAM: 'vscode' }, 'windows');
  assert.ok(unlikely.includes('Likely unsupported'));
});

test('detectKittyLikeSupport: known-good terminals report likely, VS Code reports unlikely, unrecognized reports unknown', () => {
  assert.equal(detectKittyLikeSupport({ KITTY_WINDOW_ID: '1' }), 'likely');
  assert.equal(detectKittyLikeSupport({ TERM_PROGRAM: 'ghostty' }), 'likely');
  assert.equal(detectKittyLikeSupport({ TERM_PROGRAM: 'iTerm.app' }), 'likely');
  assert.equal(detectKittyLikeSupport({ TERM_PROGRAM: 'vscode' }), 'unlikely');
  assert.equal(detectKittyLikeSupport({}), 'unknown');
  // Bare WT_SESSION is genuinely unknown - Windows Terminal only answers the kitty query on
  // Preview 1.25+, not stable, and no env var distinguishes the two.
  assert.equal(detectKittyLikeSupport({ WT_SESSION: 'abc' }), 'unknown');
});

test('appends OS-specific keyboard notes, distinct per OS and never bleeding into another OS section', () => {
  const windows = renderKeyboardCommandsHelp({}, 'windows');
  assert.ok(windows.includes('Windows keyboard notes:'));
  assert.ok(windows.includes('AltGr'));
  assert.ok(!windows.includes('VoiceOver'));

  const macos = renderKeyboardCommandsHelp({}, 'macos');
  assert.ok(macos.includes('macOS keyboard notes:'));
  assert.ok(macos.includes('VoiceOver'));
  assert.ok(macos.includes('Mission Control'));

  const linux = renderKeyboardCommandsHelp({}, 'linux');
  assert.ok(linux.includes('Linux keyboard notes:'));
  assert.ok(linux.includes('WSL'));
  assert.ok(linux.includes('virtual terminal'));

  // Every variant still shows the "how to see other OSes" hint.
  assert.ok(windows.includes('/keyboardcommands windows|mac|linux'));
});

test('defaults osKey to the current OS when not given explicitly', () => {
  // No osKey argument - falls back to detectCurrentOs(), which resolves to whatever this test
  // process's real platform is. Just confirm it picks exactly one of the three sections, not a
  // crash and not all three at once.
  const help = renderKeyboardCommandsHelp({});
  const sectionCount = ['Windows keyboard notes:', 'macOS keyboard notes:', 'Linux keyboard notes:'].filter(
    (label) => help.includes(label),
  ).length;
  assert.equal(sectionCount, 1);
});
