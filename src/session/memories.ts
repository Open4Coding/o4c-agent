import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CoreComponent } from '../agent/coreSeam.js';
import type { Tool } from '../tools/types.js';

/**
 * Memory (plan 0006 D3): short notes the model or the user wants kept across sessions - a rule
 * ("use pnpm"), a fact ("the API key lives in .env.local"), a lesson ("the flaky test is
 * auth.spec - rerun once"). Project memories live in the project's history.db; global ones in
 * ~/.o4c/db/global.db, the same table. The model gets them as a turn note, capped, only when the
 * set changed - so the request prefix stays cached - with any file a memory names checked to still
 * exist.
 */
export const MEMORIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

export type MemoryKind = 'rule' | 'fact' | 'lesson';
export const MEMORY_KINDS: readonly MemoryKind[] = ['rule', 'fact', 'lesson'];
export type MemoryScope = 'project' | 'global';

export interface MemoryRow {
  id: number;
  kind: MemoryKind;
  text: string;
  created_at: number;
  updated_at: number;
}

export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  add(text: string, kind: MemoryKind = 'fact'): MemoryRow {
    const now = Date.now();
    const r = this.db.prepare(`INSERT INTO memories (kind, text, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(kind, text, now, now);
    return { id: Number(r.lastInsertRowid), kind, text, created_at: now, updated_at: now };
  }

  update(id: number, text: string): boolean {
    return Number(this.db.prepare(`UPDATE memories SET text = ?, updated_at = ? WHERE id = ?`).run(text, Date.now(), id).changes) > 0;
  }

  remove(id: number): boolean {
    return Number(this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes) > 0;
  }

  /** Rules first, then newest. */
  list(): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories ORDER BY CASE kind WHEN 'rule' THEN 0 WHEN 'lesson' THEN 1 ELSE 2 END, updated_at DESC`).all() as unknown as MemoryRow[];
  }
}

/** The global memory store, ~/.o4c/db/global.db. */
export function openGlobalMemories(globalDbDir = join(homedir(), '.o4c', 'db')): { store: MemoryStore; close: () => void } {
  mkdirSync(globalDbDir, { recursive: true });
  const db = new DatabaseSync(join(globalDbDir, 'global.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(MEMORIES_SCHEMA);
  return { store: new MemoryStore(db), close: () => db.close() };
}

export interface MemoryStores {
  project?: MemoryStore;
  global?: MemoryStore;
}

const NOTE_MAX_CHARS = 2400;

/** Paths a memory names that are gone now - its claim may be stale. */
function missingPaths(text: string, cwd: string): string[] {
  const paths = text.match(/(?:[\w.-]+[\\/])+[\w.-]+\.\w{1,6}|\b[\w-]+\.(?:ts|tsx|js|mjs|py|go|rs|java|cs|json|md|toml|yaml|yml)\b/g) ?? [];
  return [...new Set(paths)].filter((p) => !existsSync(resolve(cwd, p)));
}

/** The note the model gets: every memory, rules first, capped; undefined when there are none. */
export function memoriesNote(stores: MemoryStores, cwd = process.cwd()): string | undefined {
  const rows: Array<MemoryRow & { scope: MemoryScope }> = [
    ...(stores.project?.list() ?? []).map((m) => ({ ...m, scope: 'project' as const })),
    ...(stores.global?.list() ?? []).map((m) => ({ ...m, scope: 'global' as const })),
  ];
  if (rows.length === 0) return undefined;
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const m of rows) {
    const gone = missingPaths(m.text, cwd);
    const line = `- [${m.kind}${m.scope === 'global' ? ', global' : ''}] ${m.text}${gone.length ? ` (note: ${gone.join(', ')} no longer exists - this may be stale)` : ''}`;
    if (used + line.length > NOTE_MAX_CHARS) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length;
  }
  return `[o4c] Remembered from earlier sessions (follow the rules; facts and lessons may help):\n${lines.join('\n')}${dropped ? `\n(${dropped} more not shown - /memory lists them all)` : ''}`;
}

/** Gives the memories as a turn note - only when they changed, which the seam handles. */
export function memoriesComponent(stores: MemoryStores): CoreComponent {
  return { name: 'memories', turnNote: () => memoriesNote(stores) };
}

export function createRememberTool(stores: MemoryStores): Tool {
  return {
    name: 'remember',
    description:
      'Save a short note for future sessions: a rule the user stated ("always use pnpm"), a fact about the project, or a lesson learned. Only what will still matter later; one sentence.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note, one sentence.' },
        kind: { type: 'string', enum: ['rule', 'fact', 'lesson'], description: 'Default fact.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'global = every project. Default project.' },
      },
      required: ['text'],
    },
    async execute(input) {
      const text = String(input.text ?? '').trim();
      if (!text) return 'Error: remember needs "text".';
      if (text.length > 500) return 'Error: keep a memory to one sentence (under 500 characters).';
      const kind = MEMORY_KINDS.includes(input.kind as MemoryKind) ? (input.kind as MemoryKind) : 'fact';
      const scope: MemoryScope = input.scope === 'global' ? 'global' : 'project';
      const store = scope === 'global' ? stores.global : stores.project ?? stores.global;
      if (!store) return 'Error: there is nowhere to keep memories here (no trusted project).';
      const row = store.add(text, kind);
      return `Remembered (#${row.id}, ${kind}, ${store === stores.global ? 'global' : 'project'}). The user can see and change it with /memory.`;
    },
  };
}

// The stores this process uses, for the TUI's /memory (set once at startup by cli.ts).
let active: MemoryStores = {};
export function setActiveMemoryStores(stores: MemoryStores): void {
  active = stores;
}
export function activeMemoryStores(): MemoryStores {
  return active;
}
