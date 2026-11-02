import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextEntry } from '../agent/contextEntry.js';
import { PLANS_SCHEMA, PlanStore } from './planStore.js';
import { redactSecrets } from './redact.js';

/** `history.db` itself - the WAL sidecars (`-wal`/`-shm`) appear alongside it during normal use
 * and fold back into this file on checkpoint. See docs/o4c-agent-design.md §4.1/§4.2.
 *
 * Renamed from `index.db` on 2026-10-18, while nothing in production constructed this store and
 * no such file existed on disk. `index.db` was a misleading name for a *record* store and kept
 * inviting the Code Graph to share the file - which it must not, because WAL allows one writer
 * per database and this store takes small live appends mid-turn while the graph does bulk
 * reindex writes. The graph lives beside it as `datagraph.db`; see `dbDirFor`. */
export const INFINITE_CONTEXT_DB_FILENAME = 'history.db';

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
  /** The task (one exchange) this entry belongs to - see `TaskRow`. Null for entries written
   * outside any task, e.g. a system notice before the first message. */
  task_id: number | null;
  content: string;
}

/**
 * One task - **one exchange**: a user message through the final answer, everything in between
 * (design brief 0004, Q6). The unit retrieval works in: search finds tasks, never loose entries,
 * and what it hands back is a task's *key parts* - `request`, `answer`, `notes`, `errors`, `files` - which
 * are kept here, denormalized, so a search never reads the bulky entries (full tool outputs, file
 * contents, think blocks) that design doc 4.8 says drive the store's growth. Those can later be
 * archived without retrieval noticing (brief, Q10).
 */
export interface TaskRow {
  id: number;
  session_id: string;
  /** The task this one follows up, always a top-level task. Null for a top-level task. */
  parent_task_id: number | null;
  /** 0 for a top-level task, 1..n for its follow-ups - shown as `#502.1`. */
  sub_no: number;
  /** The user's own message, first line, trimmed (brief, Q7). Never model-written. */
  title: string;
  request: string;
  answer: string;
  /**
   * What the task worked out on the way to its answer: the narration between tool calls that a
   * later response replaced, and the end of each think block, one line each, newest kept
   * (`TASK_NOTES_CHARS`). Schema 2, 2026-11-01 - on the tmp4 long run a research-heavy turn's
   * findings lived only in probe output and think blocks, so the next turn re-derived them.
   */
  notes: string;
  errors: string;
  /** Paths the task wrote, one per line. */
  files: string;
  /** `open` while the exchange runs; `done` once a later task starts after it answered,
   * `incomplete` if it never produced an answer. Not a judgement of correctness - that is
   * `worked`, which is only ever set by hand. */
  outcome: 'open' | 'done' | 'incomplete';
  /** The manual "worked" mark (design doc 4.6's no-auto-inference rule, moved up to the task):
   * null never marked, 1 worked, 0 did not. */
  worked: number | null;
  /** How often a search showed this task and the model picked it. Automatic; feeds ranking. */
  used_count: number;
  started_at: number;
  finished_at: number | null;
}

/** A `TaskRow` with the BM25 relevance its search gave it - lower is better, SQLite's sign. */
export interface TaskSearchRow extends TaskRow {
  bm25: number;
}

/** One definition a task changed - the link to the Code Graph (brief, Q9). `entity_uid` and the
 * hashes are `src/graph/entityId.ts`'s; null `entity_uid` means the file's language is not charted
 * and only the file itself is linked. */
export interface TaskEntityRow {
  task_id: number;
  path: string;
  entity_uid: string | null;
  name: string | null;
  kind: string | null;
  change: 'added' | 'modified' | 'renamed' | 'deleted' | 'written';
  hash_before: string | null;
  hash_after: string | null;
}

/** One search, as `search_log` keeps it: what was asked, what was shown, what was picked. */
export interface SearchLogInput {
  session_id: string;
  /** The task that was running when the search happened. */
  task_id: number | null;
  /** Which surface searched: the model's own tool, the pointer hint, or curated context. */
  source: 'tool' | 'pointer' | 'curated' | 'ultraplan';
  query: string;
  shown: readonly number[];
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
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  worktree_path TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_task_id INTEGER REFERENCES tasks(id),
  sub_no INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  errors TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'open',
  worked INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, sub_no);

-- What a search reads: the key parts only. Same external-content recipe as entries_fts.
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title, request, answer, errors, files, notes, content='tasks', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, request, answer, errors, files, notes)
  VALUES (new.id, new.title, new.request, new.answer, new.errors, new.files, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, request, answer, errors, files, notes)
  VALUES ('delete', old.id, old.title, old.request, old.answer, old.errors, old.files, old.notes);
END;
-- Only when a searchable column changes: used_count and outcome move on every search and every
-- turn, and re-indexing the whole row for those would be pure waste.
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE OF title, request, answer, errors, files, notes ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, request, answer, errors, files, notes)
  VALUES ('delete', old.id, old.title, old.request, old.answer, old.errors, old.files, old.notes);
  INSERT INTO tasks_fts(rowid, title, request, answer, errors, files, notes)
  VALUES (new.id, new.title, new.request, new.answer, new.errors, new.files, new.notes);
END;

CREATE TABLE IF NOT EXISTS task_entities (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,
  entity_uid TEXT,
  name TEXT,
  kind TEXT,
  change TEXT NOT NULL,
  hash_before TEXT,
  hash_after TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_task_entities_task ON task_entities(task_id);
CREATE INDEX IF NOT EXISTS idx_task_entities_uid ON task_entities(entity_uid) WHERE entity_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_entities_path ON task_entities(path);

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id INTEGER,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  shown TEXT NOT NULL,
  picked TEXT NOT NULL DEFAULT ''
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
  task_id INTEGER REFERENCES tasks(id),
  content TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(task_id);

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

/** Bumped whenever the schema changes shape. Version 1 is the first one that ever reached a real
 * project's `.o4c/db/` (2026-10-31); anything later needs a migration keyed on this.
 * 2 (2026-11-01): `tasks.notes`, also searched - see `migrate`.
 * 3 (2026-11-01): plans and their checklists (`planStore.ts`) - new tables only, so no migration. */
export const HISTORY_SCHEMA_VERSION = 3;

/** How much of a task's notes is kept - the newest, since later findings build on earlier ones. */
export const TASK_NOTES_CHARS = 6000;

/** How much of one note (a narration line, the end of a think block) is kept. */
export const TASK_NOTE_CHARS = 400;

/** How long a task title may be - the brief's "first line, about 80 characters". */
export const TASK_TITLE_CHARS = 80;

/** A task's title: the first non-empty line of what the user typed, whitespace collapsed, cut at
 * `TASK_TITLE_CHARS`. Free and never wrong, because it is what was asked (brief, Q7). */
export function deriveTaskTitle(request: string): string {
  const line = request.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l !== '') ?? '';
  return line.length > TASK_TITLE_CHARS ? `${line.slice(0, TASK_TITLE_CHARS - 3).trimEnd()}...` : line;
}

/** `#502` or `#502.1` - how a task is named everywhere it is shown. */
export function taskNumber(task: Pick<TaskRow, 'id' | 'parent_task_id' | 'sub_no'>): string {
  return task.parent_task_id === null ? `#${task.id}` : `#${task.parent_task_id}.${task.sub_no}`;
}

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
  private planStore: PlanStore | undefined;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    const rebuildTaskIndex = this.migrate();
    this.db.exec(SCHEMA);
    this.db.exec(PLANS_SCHEMA);
    if (rebuildTaskIndex) this.db.exec(`INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild');`);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(HISTORY_SCHEMA_VERSION));
  }

  /**
   * Brings a version-1 store up to date before `SCHEMA` runs (whose `IF NOT EXISTS` would
   * otherwise keep the old shapes): adds `tasks.notes`, and drops the task index and its triggers
   * so `SCHEMA` recreates them with the new column. Returns whether that index needs rebuilding.
   */
  private migrate(): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(tasks)`).all() as unknown as { name: string }[];
    if (columns.length === 0 || columns.some((c) => c.name === 'notes')) return false;
    this.db.exec(`
      ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT '';
      DROP TRIGGER IF EXISTS tasks_ai;
      DROP TRIGGER IF EXISTS tasks_ad;
      DROP TRIGGER IF EXISTS tasks_au;
      DROP TABLE IF EXISTS tasks_fts;
    `);
    return true;
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
  insertEntry(rawEntry: ContextEntry, taskId?: number): void {
    // Held credentials never reach the database (design §3.4); `redacted` says it happened.
    const content = redactSecrets(rawEntry.content);
    const entry = content === rawEntry.content ? rawEntry : { ...rawEntry, content, redacted: true };
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
          input_tokens, output_tokens, is_correct, redacted, tool_call_id, task_id, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        taskId ?? null,
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

  // ---- Tasks (brief 0004) ----

  /**
   * Opens a task for a new exchange. `followUpOf` makes it a follow-up: it is filed under that
   * task's top-level task (a follow-up of a follow-up joins the same thread rather than nesting)
   * with the next sub-number.
   */
  startTask(input: { session_id: string; request: string; started_at?: number; followUpOf?: number }): TaskRow {
    let parent: number | null = null;
    let subNo = 0;
    if (input.followUpOf !== undefined) {
      const of = this.getTask(input.followUpOf);
      if (of) {
        parent = of.parent_task_id ?? of.id;
        const max = this.db
          .prepare(`SELECT COALESCE(MAX(sub_no), 0) AS n FROM tasks WHERE parent_task_id = ?`)
          .get(parent) as { n: number };
        subNo = max.n + 1;
      }
    }
    const result = this.db
      .prepare(
        `INSERT INTO tasks (session_id, parent_task_id, sub_no, title, request, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.session_id, parent, subNo, deriveTaskTitle(redactSecrets(input.request)), redactSecrets(input.request), input.started_at ?? Date.now());
    return this.getTask(Number(result.lastInsertRowid))!;
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  }

  /** Resolves a task number as shown (`502`, `#502`, `502.1`, `#502.1`). */
  getTaskByNumber(number: string): TaskRow | undefined {
    const match = /^#?(\d+)(?:\.(\d+))?$/.exec(number.trim());
    if (!match) return undefined;
    const id = Number(match[1]);
    if (match[2] === undefined) return this.getTask(id);
    return this.db
      .prepare(`SELECT * FROM tasks WHERE parent_task_id = ? AND sub_no = ?`)
      .get(id, Number(match[2])) as TaskRow | undefined;
  }

  /** Whether any task exists other than `taskId` and anything newer - "is there history to
   * search at all", asked before spending model calls on it. */
  hasTasksBefore(taskId: number | undefined): boolean {
    return this.db.prepare(`SELECT 1 FROM tasks WHERE id < ? LIMIT 1`).get(taskId ?? Number.MAX_SAFE_INTEGER) !== undefined;
  }

  /** The session's most recent task, or undefined before its first. */
  lastTask(sessionId: string): TaskRow | undefined {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? ORDER BY id DESC LIMIT 1`)
      .get(sessionId) as TaskRow | undefined;
  }

  /** A top-level task's follow-ups, in order. */
  followUps(rootId: number): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY sub_no`)
      .all(rootId) as unknown as TaskRow[];
  }

  setTaskAnswer(id: number, answer: string): void {
    this.db.prepare(`UPDATE tasks SET answer = ? WHERE id = ?`).run(redactSecrets(answer), id);
  }

  /** Appends one note line, keeping the newest `maxChars` - see `TaskRow.notes`. */
  addTaskNote(id: number, note: string, maxChars = TASK_NOTES_CHARS): void {
    const line = note.replace(/\s+/g, ' ').trim();
    if (!line) return;
    const task = this.getTask(id);
    if (!task) return;
    const clipped = line.length <= TASK_NOTE_CHARS ? line : `...${line.slice(-(TASK_NOTE_CHARS - 3))}`;
    let notes = task.notes ? `${task.notes}\n${clipped}` : clipped;
    if (notes.length > maxChars) {
      // Whole lines only: a note cut in half reads as a different claim.
      const cut = notes.indexOf('\n', notes.length - maxChars);
      notes = cut === -1 ? clipped : notes.slice(cut + 1);
    }
    this.db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(redactSecrets(notes), id);
  }

  /** Appends one error line, keeping the column bounded - it is a key part, read by every search
   * that returns this task, so it must stay small however badly the exchange went. */
  addTaskError(id: number, error: string, maxChars = 2000): void {
    const task = this.getTask(id);
    if (!task || task.errors.length >= maxChars) return;
    const line = error.replace(/\s+/g, ' ').trim().slice(0, 300);
    const errors = task.errors ? `${task.errors}\n${line}` : line;
    this.db.prepare(`UPDATE tasks SET errors = ? WHERE id = ?`).run(redactSecrets(errors.slice(0, maxChars)), id);
  }

  /** Records a path the task wrote, once. */
  addTaskFile(id: number, path: string): void {
    const task = this.getTask(id);
    if (!task || task.files.split('\n').includes(path)) return;
    this.db.prepare(`UPDATE tasks SET files = ? WHERE id = ?`).run(task.files ? `${task.files}\n${path}` : path, id);
  }

  /** Closes a task: `done` if it answered, `incomplete` if not. */
  finishTask(id: number, finishedAt = Date.now()): void {
    this.db
      .prepare(
        `UPDATE tasks SET outcome = CASE WHEN answer <> '' THEN 'done' ELSE 'incomplete' END, finished_at = ?
         WHERE id = ? AND outcome = 'open'`,
      )
      .run(finishedAt, id);
  }

  /**
   * Closes every task still `open` from other sessions. A task is closed by the next message in its
   * own session, so the last task of a session that ended - a one-shot run, a `/clear` - would
   * otherwise read as running forever. A session still live in another window loses nothing real:
   * its task's answer keeps updating, and `done` versus `incomplete` is only a label.
   */
  finishOtherSessionsTasks(sessionId: string, finishedAt = Date.now()): void {
    this.db
      .prepare(
        `UPDATE tasks SET outcome = CASE WHEN answer <> '' THEN 'done' ELSE 'incomplete' END, finished_at = ?
         WHERE outcome = 'open' AND session_id <> ?`,
      )
      .run(finishedAt, sessionId);
  }

  /** The manual "worked" mark. `null` clears it. */
  markWorked(id: number, worked: boolean | null): void {
    this.db.prepare(`UPDATE tasks SET worked = ? WHERE id = ?`).run(worked === null ? null : worked ? 1 : 0, id);
  }

  addTaskEntity(row: TaskEntityRow): void {
    this.db
      .prepare(
        `INSERT INTO task_entities (task_id, path, entity_uid, name, kind, change, hash_before, hash_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.task_id, row.path, row.entity_uid, row.name, row.kind, row.change, row.hash_before, row.hash_after);
  }

  taskEntities(taskId: number): TaskEntityRow[] {
    return this.db.prepare(`SELECT * FROM task_entities WHERE task_id = ?`).all(taskId) as unknown as TaskEntityRow[];
  }

  /** Tasks that touched a definition, newest first - the code-to-history direction (brief, Q9). */
  tasksForEntity(entityUid: string, limit = 20): TaskRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT t.* FROM task_entities te JOIN tasks t ON t.id = te.task_id
         WHERE te.entity_uid = ? ORDER BY t.id DESC LIMIT ?`,
      )
      .all(entityUid, limit) as unknown as TaskRow[];
  }

  /** Tasks that wrote a file, newest first. */
  tasksForPath(path: string, limit = 20): TaskRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT t.* FROM task_entities te JOIN tasks t ON t.id = te.task_id
         WHERE te.path = ? ORDER BY t.id DESC LIMIT ?`,
      )
      .all(path, limit) as unknown as TaskRow[];
  }

  /**
   * FTS5 over the tasks' key parts, best first. `match` is an FTS5 query the caller has already
   * built and quoted (`retrieval.ts` does) - raw user text is not a safe MATCH expression.
   * Weights: the title and the files changed say most about what a task was. `beforeTaskId` keeps
   * the running task (and anything newer) out, so a search never finds the exchange it runs in.
   */
  searchTasks(match: string, limit = 50, beforeTaskId?: number): TaskSearchRow[] {
    return this.db
      .prepare(
        `SELECT t.*, bm25(tasks_fts, 4.0, 2.0, 1.0, 1.0, 3.0, 1.0) AS bm25
         FROM tasks_fts JOIN tasks t ON t.id = tasks_fts.rowid
         WHERE tasks_fts MATCH ? AND t.id < ?
         ORDER BY bm25 LIMIT ?`,
      )
      .all(match, beforeTaskId ?? Number.MAX_SAFE_INTEGER, limit) as unknown as TaskSearchRow[];
  }

  /** Logs a search and returns its id, for `recordPicks`. */
  recordSearch(input: SearchLogInput): number {
    const result = this.db
      .prepare(`INSERT INTO search_log (session_id, task_id, at, source, query, shown) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.session_id, input.task_id, Date.now(), input.source, input.query, input.shown.join(','));
    return Number(result.lastInsertRowid);
  }

  /** Records which shown tasks were picked, and counts each pick toward that task's `used_count`. */
  recordPicks(searchId: number, picked: readonly number[]): void {
    if (picked.length === 0) return;
    const row = this.db.prepare(`SELECT picked FROM search_log WHERE id = ?`).get(searchId) as { picked: string } | undefined;
    if (!row) return;
    const all = [...new Set([...(row.picked ? row.picked.split(',').map(Number) : []), ...picked])];
    this.db.prepare(`UPDATE search_log SET picked = ? WHERE id = ?`).run(all.join(','), searchId);
    const bump = this.db.prepare(`UPDATE tasks SET used_count = used_count + 1 WHERE id = ?`);
    for (const id of picked) bump.run(id);
  }

  /** Plans and checklists, on this same connection - see `planStore.ts` for why. */
  plans(): PlanStore {
    this.planStore ??= new PlanStore(this.db);
    return this.planStore;
  }

  schemaVersion(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
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
