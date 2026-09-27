import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextEntry } from '../agent/contextEntry.js';

/** `index.db` itself - the WAL sidecars (`-wal`/`-shm`) appear alongside it during normal use
 * and fold back into this file on checkpoint. See docs/o4c-agent-design.md §4.1/§4.2. */
export const INFINITE_CONTEXT_DB_FILENAME = 'index.db';

export interface SessionRecord {
  id: string;
  title: string;
  /** Epoch ms, matching `entries.created_at`/`processed_at`'s own storage convention below. */
  started_at: number;
  worktree_path?: string;
}

/** One `entries` row as read back - the SQL-native shape (epoch-ms timestamps, 0/1/null tri-state
 * ints), distinct from the in-memory `ContextEntry` it was written from. Callers that need a
 * `ContextEntry` back should reconstruct it explicitly; this store doesn't do that conversion
 * itself since nothing needs it yet (§4's own `search_history` tool design formats rows as text,
 * not as `ContextEntry` objects). */
export interface EntryRow {
  id: number;
  entry_uid: string;
  type: string;
  sub_type: string | null;
  session_id: string;
  created_at: number;
  processed_at: number;
  model_id: string | null;
  think_effort: string | null;
  mutating: number | null;
  duration_ms: number | null;
  retry_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  is_correct: number | null;
  redacted: number;
  tool_call_id: string | null;
  content: string;
}

export interface SearchFilters {
  type?: string;
  sub_type?: string;
  session_id?: string;
  is_correct?: boolean;
  tag?: string;
  /** Whether a `tag` filter should also match descendants (§4.5's hierarchy) - default true. */
  includeTagDescendants?: boolean;
}

/**
 * The full schema from docs/o4c-agent-design.md §4.7's consolidated block, with two corrections
 * made directly against that block while implementing it (both mechanical reconciliations against
 * *later* decisions in the same doc, not new design):
 *
 * 1. **`entry_uid TEXT NOT NULL UNIQUE` added.** §2.1 (2026-09-26) settled that `ContextEntry.id`
 *    is a stable uuid generated once at creation and "never re-keyed on persist" - but §4.2's own
 *    benchmarks (and the `entries_fts` `content_rowid='id'` external-content syntax below) all
 *    depend on `id` being a true `INTEGER PRIMARY KEY` rowid alias, which a uuid can't be. Kept
 *    `id INTEGER PRIMARY KEY` exactly as benchmarked and added `entry_uid` to carry the
 *    `ContextEntry.id` value verbatim - this is SQLite's own internal row identifier being an
 *    implementation detail, not the entry's own stable identity being changed.
 * 2. **`tool_call_id TEXT` added.** §2.1 explicitly calls this out as "one more nullable TEXT
 *    column" the schema needs once `entries` doubles as what rebuilds a provider request - the
 *    consolidated §4.7 SQL block was written before that note and never picked it up. Added here.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  worktree_path TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  entry_uid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  sub_type TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at INTEGER NOT NULL,
  processed_at INTEGER NOT NULL,
  model_id TEXT,
  think_effort TEXT,
  mutating INTEGER,
  duration_ms INTEGER,
  retry_count INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  is_correct INTEGER,
  redacted INTEGER NOT NULL DEFAULT 0,
  tool_call_id TEXT,
  content TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type, sub_type);
CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_correct ON entries(is_correct) WHERE is_correct IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_stats ON entries(type, model_id, think_effort, is_correct, input_tokens, output_tokens);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, content='entries', content_rowid='id');

-- Keeps entries_fts in sync with entries - the standard external-content-table recipe (SQLite
-- itself does not maintain this automatically for content= tables).
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  parent_tag_id INTEGER REFERENCES tags(id)
) STRICT;
CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (entry_id, tag_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_tag_id);
`;

function toIntBool(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function toEpochMs(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * §4's infinite-context store - one `node:sqlite` `DatabaseSync` per project, WAL mode, the
 * schema above. Not itself wired into `AgentLoop` yet (that's the `onEntry` subscriber step, per
 * memory `project_o4c_agent_infinite_context_plugin_next` - this module is the storage engine and
 * data structure that step will write into, built and tested standalone first.
 */
export class InfiniteContextStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  /** Idempotent - `/resume`ing a session, or replaying an already-known one, must not fail on a
   * duplicate `sessions` row. */
  ensureSession(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, started_at, worktree_path) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(session.id, session.title, session.started_at, session.worktree_path ?? null);
  }

  /**
   * Persists exactly one `ContextEntry`, per §4/§2.1's "zero translation step" design - every
   * field on the object is written as-is; the only real work is mapping optional booleans/ISO
   * timestamps to the SQL-native ints §4's schema uses. Throws if `entry.session_id` is empty
   * (the `sessions` foreign key can't be satisfied) - a future `onEntry` subscriber must only call
   * this once a session id has actually been stamped in, not at raw append time.
   */
  insertEntry(entry: ContextEntry): void {
    if (!entry.session_id) {
      throw new Error('InfiniteContextStore.insertEntry: entry.session_id must be set before persisting');
    }
    const createdAt = toEpochMs(entry.created_at, Date.now());
    const processedAt = toEpochMs(entry.processed_at, Date.now());

    this.db
      .prepare(
        `INSERT INTO entries (
          entry_uid, type, sub_type, session_id, created_at, processed_at,
          model_id, think_effort, mutating, duration_ms, retry_count,
          input_tokens, output_tokens, is_correct, redacted, tool_call_id, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.type,
        entry.sub_type,
        entry.session_id,
        createdAt,
        processedAt,
        entry.model_id ?? null,
        entry.think_effort ?? null,
        toIntBool(entry.mutating),
        entry.duration_ms ?? null,
        entry.retry_count ?? null,
        entry.input_tokens ?? null,
        entry.output_tokens ?? null,
        toIntBool(entry.is_correct ?? undefined),
        toIntBool(entry.redacted) ?? 0,
        entry.tool_call_id ?? null,
        entry.content,
      );

    for (const tag of entry.tags ?? []) {
      this.tagEntryByUid(entry.id, tag);
    }
  }

  /** Get-or-create a tag by name, optionally nesting it under a parent (also get-or-created) -
   * §4.5's adjacency-list hierarchy. Returns the tag's row id. */
  ensureTag(name: string, parentName?: string): number {
    const parentId = parentName ? this.ensureTag(parentName) : null;
    this.db
      .prepare(`INSERT INTO tags (name, parent_tag_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`)
      .run(name, parentId);
    const row = this.db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: number };
    return row.id;
  }

  /** Links a tag (by name) onto an entry (by its `entry_uid`, i.e. `ContextEntry.id`) - the
   * public-facing form, since callers hold `ContextEntry`s, not internal integer row ids. */
  tagEntryByUid(entryUid: string, tagName: string, parentTagName?: string): void {
    const entry = this.db.prepare(`SELECT id FROM entries WHERE entry_uid = ?`).get(entryUid) as
      | { id: number }
      | undefined;
    if (!entry) throw new Error(`InfiniteContextStore.tagEntryByUid: no entry with entry_uid ${entryUid}`);
    const tagId = this.ensureTag(tagName, parentTagName);
    this.db
      .prepare(`INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?) ON CONFLICT(entry_id, tag_id) DO NOTHING`)
      .run(entry.id, tagId);
  }

  getByUid(entryUid: string): EntryRow | undefined {
    return this.db.prepare(`SELECT * FROM entries WHERE entry_uid = ?`).get(entryUid) as EntryRow | undefined;
  }

  /** Most recent first - the natural order for "what happened" lookups. */
  listByType(type: string, subType?: string, limit = 50): EntryRow[] {
    const rows = subType
      ? this.db
          .prepare(`SELECT * FROM entries WHERE type = ? AND sub_type = ? ORDER BY id DESC LIMIT ?`)
          .all(type, subType, limit)
      : this.db.prepare(`SELECT * FROM entries WHERE type = ? ORDER BY id DESC LIMIT ?`).all(type, limit);
    return rows as unknown as EntryRow[];
  }

  /**
   * Combined FTS5 + narrowing-filter search - per §4.9's own finding, a bare keyword search alone
   * risks multi-second latency at scale even with `LIMIT`, so this always requires the FTS5 match
   * and layers `SearchFilters` on top rather than exposing an unfiltered full-text search at all.
   */
  search(query: string, filters: SearchFilters = {}, limit = 20): EntryRow[] {
    const conditions: string[] = ['entries_fts MATCH ?'];
    const params: (string | number)[] = [query];

    if (filters.type) {
      conditions.push('e.type = ?');
      params.push(filters.type);
    }
    if (filters.sub_type) {
      conditions.push('e.sub_type = ?');
      params.push(filters.sub_type);
    }
    if (filters.session_id) {
      conditions.push('e.session_id = ?');
      params.push(filters.session_id);
    }
    if (filters.is_correct !== undefined) {
      conditions.push('e.is_correct = ?');
      params.push(filters.is_correct ? 1 : 0);
    }

    let sql = `
      SELECT e.* FROM entries_fts
      JOIN entries e ON e.id = entries_fts.rowid
      WHERE ${conditions.join(' AND ')}
    `;

    if (filters.tag) {
      const includeDescendants = filters.includeTagDescendants ?? true;
      sql += `
        AND e.id IN (
          SELECT entry_id FROM entry_tags WHERE tag_id IN (${
            includeDescendants
              ? `
                WITH RECURSIVE descendants(id) AS (
                  SELECT id FROM tags WHERE name = ?
                  UNION ALL
                  SELECT t.id FROM tags t JOIN descendants d ON t.parent_tag_id = d.id
                )
                SELECT id FROM descendants
              `
              : `SELECT id FROM tags WHERE name = ?`
          })
        )
      `;
      params.push(filters.tag);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as unknown as EntryRow[];
  }

  /** All entries tagged with `tagName`, or any of its descendants (§4.5's recursive-CTE case). */
  entriesByTag(tagName: string, includeDescendants = true): EntryRow[] {
    const sql = includeDescendants
      ? `
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM tags WHERE name = ?
          UNION ALL
          SELECT t.id FROM tags t JOIN descendants d ON t.parent_tag_id = d.id
        )
        SELECT e.* FROM entries e
        JOIN entry_tags et ON et.entry_id = e.id
        WHERE et.tag_id IN (SELECT id FROM descendants)
        ORDER BY e.id DESC
      `
      : `
        SELECT e.* FROM entries e
        JOIN entry_tags et ON et.entry_id = e.id
        JOIN tags t ON t.id = et.tag_id
        WHERE t.name = ?
        ORDER BY e.id DESC
      `;
    return this.db.prepare(sql).all(tagName) as unknown as EntryRow[];
  }

  /** Folds the WAL back into the main `.db` file - §4.1's confirmed `wal_checkpoint(TRUNCATE)`
   * behavior. Not required for correctness (WAL mode is durable on its own), just tidiness before
   * closing, e.g. at process exit. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
