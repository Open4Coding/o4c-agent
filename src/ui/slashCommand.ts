export interface CommandInfo {
  /** Canonical form, including the leading slash, e.g. '/exit'. */
  name: string;
  aliases?: string[];
  description: string;
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
  { name: '/exit', aliases: ['/quit'], description: 'End the session.' },
];

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
 * behind the "/" command palette. An empty or bare "/" prefix matches (and lists) everything.
 */
export function matchCommands(prefix: string): CommandInfo[] {
  const needle = prefix.toLowerCase();
  return COMMANDS.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((name) => name.toLowerCase().startsWith(needle)),
  ).sort((a, b) => a.name.localeCompare(b.name));
}
