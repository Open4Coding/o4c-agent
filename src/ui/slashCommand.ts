export interface CommandInfo {
  /** Canonical form, including the leading slash, e.g. '/exit'. */
  name: string;
  aliases?: string[];
  description: string;
  /** Excluded from the main "/" palette (bare or narrowed) to avoid flooding it with narrow
   * settings - still fully invocable by typing its exact name, and listed by its family's own
   * picker (`/set` for every `/set-*`, `/config` for every `/config-*`). See docs/plans/
   * 0001.FrontEndIDEChanges.plan.md item #1. */
  hidden?: boolean;
}

// Single source of truth for the front end's own commands, used by both the "/" command palette
// and the unknown-command check in App.tsx. Once the plugin-dispatch registry
// (docs/frontend-design.md §6) exists, plugin-registered commands get merged in here rather than
// replacing this list. There's no dedicated /help - typing "/" opens a live, searchable list of
// everything here (CommandPalette.tsx), which makes a separate static listing redundant.
export const COMMANDS: CommandInfo[] = [
  { name: '/clear', description: 'Clear the current session and start fresh (still resumable via /resume).' },
  { name: '/resume', description: 'Browse and resume one of the last 20 saved sessions.' },
  {
    name: '/wipe',
    description: 'PERMANENTLY delete the current session from /resume (double confirmation required).',
  },
  {
    name: '/context',
    aliases: ['/ctx'],
    description: 'Show local token-usage for this session - no LLM call.',
  },
  {
    name: '/keyboardcommands',
    description: 'List input-box keybindings and OS-specific notes. Usage: /keyboardcommands [windows|mac|linux]',
  },
  {
    name: '/mode',
    description: 'Switch between Manual, Auto, Accept Edits, and Plan mode.',
  },
  { name: '/exit', aliases: ['/quit'], description: 'End the session.' },
  { name: '/set', description: 'Browse and run a /set-* setting command.' },
  {
    name: '/set-sessionname',
    description: 'Rename the current session (shown in /resume). Usage: /set-sessionname <name>',
    hidden: true,
  },
  {
    name: '/config',
    description: 'Browse and run a /config-* plugin setting command.',
  },
  // No /config-<pluginname> entries yet - this round builds the frontend surface and the
  // local/global config-store foundation only, not real plugin loading (see docs/plans/
  // 0001.FrontEndIDEChanges.plan.md #6). configCommands() below returns [] until a real plugin
  // registers one; /config's own handler already treats an empty family as "nothing to
  // configure yet," the same way /set's does today.
];

/** Every registered `/set-*` command, in the order they'd appear in `/set`'s own picker -
 * includes hidden ones, since that picker is exactly how a hidden `/set-*` command gets found. */
export function setCommands(): CommandInfo[] {
  return COMMANDS.filter((c) => c.name.startsWith('/set-'));
}

/** Every registered `/config-*` command, in the order they'd appear in `/config`'s own picker -
 * the plugin-config counterpart to `setCommands()` above, same shape. */
export function configCommands(): CommandInfo[] {
  return COMMANDS.filter((c) => c.name.startsWith('/config-'));
}

export const KNOWN_COMMANDS = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

/**
 * Whether `input` looks like an attempted slash command, as opposed to ordinary text that
 * happens to start with `/` (e.g. a pasted Unix path). A command's first word has no further
 * `/` in it: `/clear` is a command attempt, `/Users/x/file.md` is not.
 */
export function looksLikeSlashCommand(input: string): boolean {
  if (!input.startsWith('/')) return false;
  const firstWord = input.split(/\s/, 1)[0];
  return !firstWord.slice(1).includes('/');
}

/** The `/word` portion of a slash-command attempt (no arguments). */
export function commandName(input: string): string {
  return input.split(/\s/, 1)[0];
}

/**
 * Whether `value` is still being composed as a command name - starts with `/`, no space typed
 * yet (once a space appears the user has moved on to arguments, not the command itself), and
 * isn't a pasted-path false positive. Used to decide whether the live command palette should
 * be showing at all.
 */
export function isComposingCommand(value: string): boolean {
  return looksLikeSlashCommand(value) && !value.includes(' ');
}

/**
 * Commands (matched by canonical name or any alias) whose name starts with `prefix`,
 * case-insensitively, sorted alphabetically ascending by canonical name - the live-filtered list
 * behind the "/" command palette. An empty or bare "/" prefix matches (and lists) everything
 * *non-hidden* - a `hidden` command never appears here, in a narrowed search or not, by design
 * (see `CommandInfo.hidden`'s doc comment): it's still directly invocable by its exact name, and
 * discoverable via its own family's picker instead.
 */
export function matchCommands(prefix: string): CommandInfo[] {
  const needle = prefix.toLowerCase();
  return COMMANDS.filter(
    (c) =>
      !c.hidden && [c.name, ...(c.aliases ?? [])].some((name) => name.toLowerCase().startsWith(needle)),
  ).sort((a, b) => a.name.localeCompare(b.name));
}
