import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * User key remapping (plan 0006 E17): `~/.o4c/keybindings.json` moves o4c's Ctrl+letter actions to
 * other Ctrl+letters, e.g. `{ "editor": "ctrl+e", "line-end": "ctrl+g" }`. Only Ctrl+A-Z - the set
 * every terminal on every platform delivers (docs keyboard reference) - and never Ctrl+C (exit
 * guard), Ctrl+H/I/M (terminals send them as Backspace, Tab and Enter) or Ctrl+J (newline). Two
 * actions on one key is refused, and a refused entry keeps its default rather than half-applying.
 * Read once per process; o4c reloads after most turns, so an edit takes effect almost at once.
 */
export const KEY_ACTIONS = {
  'line-start': { key: 'a', label: 'Jump to the start of the whole input' },
  'line-end': { key: 'e', label: 'Jump to the end of the whole input' },
  'editor': { key: 'g', label: 'Compose the message in your editor' },
  'drop-queue': { key: 'k', label: 'Drop everything waiting to run (shown while something is queued)' },
  'next-paragraph': { key: 'n', label: 'Jump to the next paragraph' },
  'expand-pastes': { key: 'o', label: 'Expand collapsed pastes' },
  'prev-paragraph': { key: 'p', label: 'Jump to the previous paragraph' },
  'queue': { key: 'q', label: 'Queue the typed message to run after the current turn' },
  'history-search': { key: 'r', label: 'Search input history' },
  'stop-thinking': { key: 't', label: 'Stop thinking, answer now' },
  'kill-line': { key: 'u', label: 'Kill to the cursor (Up yanks it back)' },
  'sessions': { key: 'x', label: 'Sessions: this one and the background ones (/session)' },
} as const;

export type KeyAction = keyof typeof KEY_ACTIONS;
export const RESERVED_KEYS = ['c', 'h', 'i', 'j', 'm'];

export function keybindingsFile(): string {
  return join(homedir(), '.o4c', 'keybindings.json');
}

export interface Keybindings {
  keys: Record<KeyAction, string>;
  errors: string[];
}

function defaults(): Record<KeyAction, string> {
  return Object.fromEntries(Object.entries(KEY_ACTIONS).map(([a, v]) => [a, v.key])) as Record<KeyAction, string>;
}

/** Validates `raw` (the parsed file) over the defaults. */
export function resolveKeybindings(raw: unknown): Keybindings {
  const keys = defaults();
  const errors: string[] = [];
  if (raw === undefined) return { keys, errors };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { keys, errors: ['keybindings.json must be an object of "action": "ctrl+<letter>".'] };
  const wanted: Partial<Record<KeyAction, string>> = {};
  for (const [action, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(action in KEY_ACTIONS)) {
      errors.push(`Unknown action "${action}" - one of: ${Object.keys(KEY_ACTIONS).join(', ')}.`);
      continue;
    }
    const m = typeof value === 'string' ? /^ctrl\+([a-z])$/i.exec(value.trim()) : null;
    if (!m) {
      errors.push(`"${action}": "${String(value)}" is not ctrl+<letter>.`);
      continue;
    }
    const letter = m[1]!.toLowerCase();
    if (RESERVED_KEYS.includes(letter)) {
      errors.push(`"${action}": ctrl+${letter} is reserved (Ctrl+C exit guard; Ctrl+H/I/J/M arrive as Backspace/Tab/newline/Enter).`);
      continue;
    }
    wanted[action as KeyAction] = letter;
  }
  const next = { ...keys, ...wanted };
  const byKey = new Map<string, KeyAction[]>();
  for (const [a, k] of Object.entries(next) as [KeyAction, string][]) byKey.set(k, [...(byKey.get(k) ?? []), a]);
  for (const [k, actions] of byKey) {
    if (actions.length < 2) continue;
    errors.push(`ctrl+${k} is bound to ${actions.join(' and ')} - each keeps its default.`);
    for (const a of actions) if (wanted[a] !== undefined) next[a] = keys[a];
  }
  // A reverted entry can collide with another one's default; the defaults themselves never collide.
  const final = new Set(Object.values(next));
  return { keys: final.size === Object.keys(next).length ? next : keys, errors };
}

let current: Keybindings | undefined;

export function keybindings(): Keybindings {
  if (!current) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(keybindingsFile(), 'utf-8'));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      current = missing ? resolveKeybindings(undefined) : { keys: defaults(), errors: [`keybindings.json could not be read: ${(err as Error).message}`] };
      return current;
    }
    current = resolveKeybindings(raw);
  }
  return current;
}

export function setKeybindingsForTests(next: Keybindings | undefined): void {
  current = next;
}

/** Is this keypress the given action? */
export function isAction(action: KeyAction, input: string, key: { ctrl: boolean }): boolean {
  return key.ctrl && input === keybindings().keys[action];
}

/** "Ctrl+R" for an action, as the user has it bound. */
export function keyLabel(action: KeyAction): string {
  return `Ctrl+${keybindings().keys[action].toUpperCase()}`;
}

/** `/keyboard-bindings`: every remappable action, its key, and anything wrong with the file. */
export function describeKeybindings(): string[] {
  const kb = keybindings();
  return [
    `Key bindings (${keybindingsFile()} - remap with "action": "ctrl+<letter>"):`,
    ...(Object.entries(KEY_ACTIONS) as [KeyAction, { key: string; label: string }][]).map(([a, v]) => {
      const k = kb.keys[a];
      return `  ${`Ctrl+${k.toUpperCase()}`.padEnd(8)} ${a.padEnd(15)} ${v.label}${k !== v.key ? ` (default Ctrl+${v.key.toUpperCase()})` : ''}`;
    }),
    ...(kb.errors.length ? ['', 'Problems in the file (those entries keep their defaults):', ...kb.errors.map((e) => `  ${e}`)] : []),
  ];
}
