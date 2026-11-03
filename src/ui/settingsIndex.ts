import type { ConfigScope, ConfigStore } from '../session/configStore.js';

/**
 * `/settings` (plan 0006 E23, 0002 item 10): one place that lists every setting command with its
 * current value and the scope that value comes from; picking one runs that command. The commands
 * stay where they are (`/set-*` for session behaviour, `/config-*` for appearance and plumbing) -
 * this is the index over both, so nobody has to remember which family a setting lives in.
 */
export interface SettingRow {
  command: string;
  /** The config key the command writes; `entry` when it is one model's entry in a per-model map. */
  key?: string;
  entry?: 'model';
  /** What an unset key means. */
  unset: string;
}

export const SETTINGS: readonly SettingRow[] = [
  { command: '/set-think', key: 'thinkLevelByModel', entry: 'model', unset: 'med (default)' },
  { command: '/set-contextwindowtype', key: 'contextWindowType', unset: 'default' },
  { command: '/set-sessionview', key: 'sessionView', unset: 'default' },
  { command: '/set-sessionsToSave', key: 'sessionsToSave', unset: 'default' },
  { command: '/set-blockgap', key: 'blockGap', unset: '1 (default)' },
  { command: '/set-shell', key: 'shell', unset: 'auto' },
  { command: '/set-notify', key: 'notify', unset: 'bell (default)' },
  { command: '/set-mouse', key: 'mouse', unset: 'off (default)' },
  { command: '/set-autoallowreadonly', key: 'autoAllowReadOnly', unset: 'off (default)' },
  { command: '/set-pinnedcommands', key: 'pinnedCommands', unset: 'none' },
  { command: '/set-sessionname', unset: 'this session\'s title' },
  { command: '/config-highlightcolor', key: 'highlightColor', unset: 'default' },
  { command: '/config-editor', key: 'editor', unset: 'VISUAL / EDITOR' },
  { command: '/config-contextwindow-modelinitiatedsearches', key: 'modelInitiatedSearches', unset: 'auto (default)' },
  { command: '/config-model', unset: 'see /view-model' },
];

const PRECEDENCE: readonly ConfigScope[] = ['personal', 'local', 'solution', 'global'];

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Each setting's effective value and where it comes from - the highest-precedence scope that has it. */
export async function settingValues(store: ConfigStore, model: string): Promise<{ command: string; value: string; scope?: ConfigScope }[]> {
  const scopes = await Promise.all(PRECEDENCE.map(async (sc) => [sc, store.hasScope(sc) ? await store.readScope(sc) : {}] as const));
  return SETTINGS.map((row) => {
    if (!row.key) return { command: row.command, value: row.unset };
    for (const [scope, data] of scopes) {
      let v = data[row.key];
      if (row.entry === 'model') v = v && typeof v === 'object' ? (v as Record<string, unknown>)[model] : undefined;
      if (v !== undefined && v !== '') return { command: row.command, value: show(v), scope };
    }
    return { command: row.command, value: row.unset };
  });
}

/** One dropdown row: command, value, scope. */
export function settingLabel(s: { command: string; value: string; scope?: ConfigScope }): string {
  return `${s.command} - ${s.value}${s.scope ? ` (${s.scope})` : ''}`;
}

/** The blank rows between finished blocks (E23): 0, 1 (default) or 2. */
export const BLOCK_GAP_KEY = 'blockGap';
export function parseBlockGap(v: unknown): 0 | 1 | 2 {
  return v === 0 || v === 2 ? v : 1;
}
