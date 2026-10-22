/**
 * The Code Graph's on-disk store - build step 2 of `docs/research/code-graph/0000.DECISION.md`.
 *
 * SQLite via `node:sqlite`, WAL mode, at `.o4c/db/graph.db`. Not a graph database: the fastest
 * system measured in the research (28M LOC in 3 minutes, sub-millisecond queries) uses SQLite,
 * which retired Neo4j/Memgraph/FalkorDB/Qdrant for this scale.
 *
 * ## What is stored, and what is deliberately not
 *
 * Definitions and references per file, keyed by **content-addressed identity** (`entityId.ts`),
 * never by `path:line`. References carry an **edge kind** (`edgeKind.ts`) so a type annotation
 * is never recorded as a call - the single cheapest precision win available, per lidx's measured
 * false-positive breakdown.
 *
 * Import bindings per file as well, since step 5: `local name -> module specifier`, stored as
 * written and resolved at query time (`imports.ts`). They exist to let the resolver break ties a
 * bare name cannot, which the acceptance measurement identified as four fifths of the remaining
 * recall gap.
 *
 * What is *not* stored: resolved call edges. Extraction sees one file at a time and cannot know
 * how many definitions of a name the repository holds, so resolution belongs to the ranking
 * stage. This is also the honest position given that externally-graded recall for resolved call
 * graphs ranges 0.026-0.967 with nothing saying at query time which regime you are in.
 *
 * ## Freshness
 *
 * Fingerprints are taken over **working-tree bytes**, not git state. A file edited and not
 * committed is the file the model is about to read; an index keyed on commits would call it
 * fresh while being wrong about it.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Tag } from './tags.js';
import type { ImportBinding } from './imports.js';
import { edgeKindForCapture, type EdgeKind } from './edgeKind.js';
import { entityUid, contentHash, fileHash, normalisePath, kindFromCapture } from './entityId.js';
import { searchTextFor } from './identifierSplit.js';

/** `graph.db` itself; its `-wal`/`-shm` sidecars sit beside it. See `dbDirFor`. */
export const GRAPH_DB_FILENAME = 'graph.db';

/**
 * Schema version, bumped when a migration would be needed. A mismatch triggers a rebuild.
 *
 * 2 adds the `imports` table; 3 adds `files.index_seq`. No migration is written because none is
 * worth writing: the graph is derived from files on disk and rebuilding it costs seconds, which is
 * also why a bump discards rather than migrates.
 */
export const GRAPH_SCHEMA_VERSION = 3;

/**
 * Per-file index state.
 *
 * `stale` and `absent` are distinct on purpose: `stale` means "indexed, but the file has changed
 * since", `absent` means "never indexed". Collapsing them would let an unindexed file read as an
 * empty one, which is the failure mode the four-state verdict exists to prevent.
 */
export type FileFreshness = 'fresh' | 'stale' | 'absent';

export interface IndexedFile {
  readonly path: string;
  readonly language: string;
  readonly fileHash: string;
  readonly size: number;
  readonly indexedAt: number;
  readonly defCount: number;
  readonly refCount: number;
  /**
   * Monotonic write counter, used to tell "indexed before this pass began" from "indexed while it
   * was running" - the question the end-of-pass sweep has to answer now that a worker and the
   * main thread both write.
   *
   * A counter rather than `indexedAt`, because `Date.now()` on Windows advances in steps of up to
   * 16 ms. A file indexed in the same tick as a pass start compares equal to it, and the first
   * version of the sweep guard used the timestamp and failed intermittently for exactly that
   * reason.
   */
  readonly indexSeq: number;
}

/** A definition as read back. */
export interface DefinitionRow {
  readonly entityUid: string;
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly capture: string;
  readonly line: number;
  readonly contentHash: string;
}

/** A reference as read back. */
export interface ReferenceRow {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly capture: string;
  readonly edgeKind: EdgeKind;
  readonly line: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  def_count INTEGER NOT NULL,
  ref_count INTEGER NOT NULL,
  index_seq INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

CREATE TABLE IF NOT EXISTS defs (
  id INTEGER PRIMARY KEY,
  entity_uid TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  capture TEXT NOT NULL,
  line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  search_text TEXT NOT NULL
) STRICT;

-- Ranking walks name -> defining files and name -> referencing files constantly, so both
-- directions are indexed. entity_uid is indexed because the history store joins on it.
CREATE INDEX IF NOT EXISTS idx_defs_name ON defs(name);
CREATE INDEX IF NOT EXISTS idx_defs_file ON defs(file_id);
CREATE INDEX IF NOT EXISTS idx_defs_uid ON defs(entity_uid);

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  capture TEXT NOT NULL,
  edge_kind TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_edge ON refs(edge_kind);

-- The module column is the specifier exactly as written, not a resolved path. Resolving it needs
-- the importing file's own path and is pure string work (see imports.ts), so doing it at query
-- time costs nothing and avoids a second derived column that could fall out of step with the
-- first. (No backticks in here: this whole block is a template literal.)
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  local_name TEXT NOT NULL,
  module TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;

-- The resolver's question is always "in this file, where did this name come from", so the index
-- is on the pair rather than on either column.
CREATE INDEX IF NOT EXISTS idx_imports_file_name ON imports(file_id, local_name);
`;

/**
 * FTS5 over `defs.search_text`, as an external-content table. Created separately from `SCHEMA`
 * because FTS5 is a **build-time option** in the SQLite that `node:sqlite` embeds, not a runtime
 * guarantee - so its absence must degrade rather than throw.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS defs_fts USING fts5(search_text, content='defs', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS defs_ai AFTER INSERT ON defs BEGIN
  INSERT INTO defs_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS defs_ad AFTER DELETE ON defs BEGIN
  INSERT INTO defs_fts(defs_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS defs_au AFTER UPDATE ON defs BEGIN
  INSERT INTO defs_fts(defs_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  INSERT INTO defs_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
`;

/** What one file's extraction contributes. */
export interface FileIndexInput {
  /** Repo-relative path; normalised on the way in. */
  readonly path: string;
  readonly language: string;
  /** The file's full source, for the file fingerprint and per-entity content hashes. */
  readonly source: string;
  readonly tags: readonly Tag[];
  /** Optional, and absent for most languages: only some have an import query. */
  readonly imports?: readonly ImportBinding[];
}

/** What `stats()` reports. */
export interface GraphStats {
  readonly files: number;
  readonly defs: number;
  readonly refs: number;
  readonly calls: number;
}

export class GraphStore {
  private readonly db: DatabaseSync;
  /** See `stats()`: the counts are on the per-annotation path and cost 25 ms uncached at scale. */
  private cachedStats: { version: number; stats: GraphStats } | undefined;
  /** False when the embedded SQLite was built without FTS5; name search then falls back. */
  readonly ftsAvailable: boolean;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL so a reindex and a serve can overlap: readers are not blocked by the writer.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    // Two writers now exist: the indexing worker and, on a read or a write tool, this thread.
    // `DatabaseSync` is synchronous, so this timeout is also a worst-case stall on whichever
    // thread loses the race - which is why it is a few hundred milliseconds and not the seconds
    // a server would use. A per-file transaction is milliseconds long, so riding one out is all
    // that is needed; losing anyway costs one file's rows, which `freshness` then reports as
    // stale rather than as absent.
    this.db.exec('PRAGMA busy_timeout = 400;');
    this.db.exec(SCHEMA);

    this.ftsAvailable = this.tryCreateFts();

    const stored = this.meta('schema_version');
    if (stored === undefined) {
      this.setMeta('schema_version', String(GRAPH_SCHEMA_VERSION));
    } else if (Number(stored) !== GRAPH_SCHEMA_VERSION) {
      // The graph is derived and disposable - rebuilding is seconds of work, so a version
      // mismatch is cheaper to discard than to migrate. The history store, being
      // irreplaceable, must never take this branch, which is one reason they are separate files.
      this.clear();
      this.setMeta('schema_version', String(GRAPH_SCHEMA_VERSION));
    }
  }

  /**
   * Creates the FTS5 table, reporting rather than throwing when FTS5 is unavailable.
   *
   * Checked here, once, at open. The alternative - discovering it at the first search - would
   * mean a feature that works all session until the moment someone searches.
   */
  private tryCreateFts(): boolean {
    try {
      this.db.exec(FTS_SCHEMA);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The write counter's current value, to be captured before a pass starts.
   *
   * Anything written after this point has a higher sequence, which is how the sweep tells a row
   * that is merely older than the pass from one written during it by another writer.
   */
  currentSequence(): number {
    return Number(this.meta('index_seq') ?? '0');
  }

  private nextSequence(): number {
    const next = this.currentSequence() + 1;
    this.setMeta('index_seq', String(next));
    return next;
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * Replaces everything known about one file, in a single transaction.
   *
   * Replace rather than merge: a re-extraction is the whole truth about that file, and merging
   * would leave behind definitions that have since been deleted - which would then be served to
   * the model as though they still existed.
   */
  indexFile(input: FileIndexInput): void {
    this.cachedStats = undefined;
    const path = normalisePath(input.path);
    const hash = fileHash(input.source);
    const lines = input.source.split('\n');

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path);

      const defs = input.tags.filter((t) => t.kind === 'def');
      const refs = input.tags.filter((t) => t.kind === 'ref');

      // Allocated inside the transaction, so two writers cannot be handed the same number.
      const seq = this.nextSequence();
      this.db
        .prepare(
          `INSERT INTO files(path, language, file_hash, size, indexed_at, def_count, ref_count, index_seq)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          path,
          input.language,
          hash,
          input.source.length,
          Date.now(),
          defs.length,
          refs.length,
          seq,
        );
      const fileId = Number(
        (this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as { id: number }).id,
      );

      const insertDef = this.db.prepare(
        `INSERT INTO defs(entity_uid, file_id, name, kind, capture, line, content_hash, search_text)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const tag of defs) {
        const kind = kindFromCapture(tag.capture);
        insertDef.run(
          entityUid({ language: input.language, path, kind, name: tag.name }),
          fileId,
          tag.name,
          kind,
          tag.capture,
          tag.line,
          // The entity's own text is not delimited by the tag (a tag is the *name* node), so the
          // declaring line stands in as the fingerprint source until step 3 carries node ranges.
          contentHash(lines[tag.line - 1] ?? tag.name),
          searchTextFor(tag.name),
        );
      }

      const insertRef = this.db.prepare(
        `INSERT INTO refs(file_id, name, kind, capture, edge_kind, line) VALUES(?, ?, ?, ?, ?, ?)`,
      );
      for (const tag of refs) {
        insertRef.run(
          fileId,
          tag.name,
          kindFromCapture(tag.capture),
          tag.capture,
          edgeKindForCapture(tag.capture),
          tag.line,
        );
      }

      const insertImport = this.db.prepare(
        `INSERT INTO imports(file_id, local_name, module, line) VALUES(?, ?, ?, ?)`,
      );
      for (const binding of input.imports ?? []) {
        insertImport.run(fileId, binding.localName, binding.module, binding.line);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Forgets a file entirely - for a deletion, or a path that no longer matches the filter. */
  removeFile(path: string): void {
    this.cachedStats = undefined;
    this.db.prepare('DELETE FROM files WHERE path = ?').run(normalisePath(path));
  }

  /**
   * Whether the index for a path matches the bytes given.
   *
   * The caller passes the current source rather than a path, so this makes no filesystem call
   * and cannot race with an edit between stat and read.
   */
  freshness(path: string, currentSource: string | Buffer): FileFreshness {
    const row = this.db
      .prepare('SELECT file_hash FROM files WHERE path = ?')
      .get(normalisePath(path)) as { file_hash: string } | undefined;
    if (!row) return 'absent';
    return row.file_hash === fileHash(currentSource) ? 'fresh' : 'stale';
  }

  /** Every indexed file. */
  files(): IndexedFile[] {
    const rows = this.db
      .prepare(
        `SELECT path, language, file_hash, size, indexed_at, def_count, ref_count, index_seq
         FROM files ORDER BY path`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toIndexedFile);
  }

  /**
   * One file's index record, or `undefined` if it was never indexed.
   *
   * Exists because `freshness` needs the file's current bytes and there are callers that do not
   * have them - a ranged `read_file` returns a slice, not the file - but still need to tell "this
   * file is not in the index" from "this file is indexed and defines nothing". Those are the two
   * the four-state verdict must never be allowed to collapse.
   */
  indexedFile(path: string): IndexedFile | undefined {
    const row = this.db
      .prepare(
        `SELECT path, language, file_hash, size, indexed_at, def_count, ref_count, index_seq
         FROM files WHERE path = ?`,
      )
      .get(normalisePath(path)) as Record<string, unknown> | undefined;
    return row ? toIndexedFile(row) : undefined;
  }

  /** Files defining a name. The list length is itself a signal - aider damps names defined in many files. */
  definitionsOf(name: string): DefinitionRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.entity_uid, f.path, d.name, d.kind, d.capture, d.line, d.content_hash
         FROM defs d JOIN files f ON f.id = d.file_id
         WHERE d.name = ? ORDER BY f.path, d.line`,
      )
      .all(name) as Array<Record<string, unknown>>;
    return rows.map(toDefinition);
  }

  /**
   * References to a name, optionally restricted to asserted call sites.
   *
   * `callsOnly` exists so a caller can ask the precision-preserving question. Defaulting to all
   * references is right for *ranking* - a type annotation is real evidence that two files relate -
   * and wrong for anything claiming to be a call graph.
   */
  referencesTo(name: string, callsOnly = false): ReferenceRow[] {
    const sql = `SELECT f.path, r.name, r.kind, r.capture, r.edge_kind, r.line
                 FROM refs r JOIN files f ON f.id = r.file_id
                 WHERE r.name = ?${callsOnly ? " AND r.edge_kind = 'call'" : ''}
                 ORDER BY f.path, r.line`;
    const rows = this.db.prepare(sql).all(name) as Array<Record<string, unknown>>;
    return rows.map(toReference);
  }

  /** Every definition in one file. */
  definitionsIn(path: string): DefinitionRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.entity_uid, f.path, d.name, d.kind, d.capture, d.line, d.content_hash
         FROM defs d JOIN files f ON f.id = d.file_id
         WHERE f.path = ? ORDER BY d.line`,
      )
      .all(normalisePath(path)) as Array<Record<string, unknown>>;
    return rows.map(toDefinition);
  }

  /** Every reference in one file. */
  referencesIn(path: string): ReferenceRow[] {
    const rows = this.db
      .prepare(
        `SELECT f.path, r.name, r.kind, r.capture, r.edge_kind, r.line
         FROM refs r JOIN files f ON f.id = r.file_id
         WHERE f.path = ? ORDER BY r.line`,
      )
      .all(normalisePath(path)) as Array<Record<string, unknown>>;
    return rows.map(toReference);
  }

  /**
   * Every import binding in one file.
   *
   * For the bulk resolver, which walks file by file and wants one query per file rather than one
   * per call site.
   */
  importsIn(path: string): ImportBinding[] {
    const rows = this.db
      .prepare(
        `SELECT i.local_name, i.module, i.line
         FROM imports i JOIN files f ON f.id = i.file_id
         WHERE f.path = ? ORDER BY i.line`,
      )
      .all(normalisePath(path)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      localName: String(r.local_name),
      module: String(r.module),
      line: Number(r.line),
    }));
  }

  /**
   * The module one name was imported from in one file, or `undefined`.
   *
   * Returns `undefined` when the name is imported twice from different modules, which is not
   * legal in a single scope but is what a half-indexed or oddly-generated file can look like.
   * Picking one would be a guess, and a guess here defeats the purpose of consulting imports.
   */
  importedModule(path: string, localName: string): string | undefined {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT i.module
         FROM imports i JOIN files f ON f.id = i.file_id
         WHERE f.path = ? AND i.local_name = ? LIMIT 2`,
      )
      .all(normalisePath(path), localName) as Array<{ module: string }>;
    return rows.length === 1 ? String(rows[0].module) : undefined;
  }

  /**
   * Name search over definitions, camel/snake aware because `search_text` was pre-split.
   *
   * Falls back to a `LIKE` scan when FTS5 is unavailable, so the feature degrades in speed
   * rather than disappearing. Callers that report a verdict should surface `ftsAvailable`.
   */
  searchDefinitions(query: string, limit = 50): DefinitionRow[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (this.ftsAvailable) {
      // Quoted as a single FTS5 phrase: a bare identifier can contain characters FTS5 reads as
      // operators, and a query string is untrusted input.
      const phrase = `"${trimmed.replace(/"/g, '""')}"*`;
      const rows = this.db
        .prepare(
          `SELECT d.entity_uid, f.path, d.name, d.kind, d.capture, d.line, d.content_hash
           FROM defs_fts JOIN defs d ON d.id = defs_fts.rowid JOIN files f ON f.id = d.file_id
           WHERE defs_fts MATCH ? ORDER BY bm25(defs_fts) LIMIT ?`,
        )
        .all(phrase, limit) as Array<Record<string, unknown>>;
      return rows.map(toDefinition);
    }

    const rows = this.db
      .prepare(
        `SELECT d.entity_uid, f.path, d.name, d.kind, d.capture, d.line, d.content_hash
         FROM defs d JOIN files f ON f.id = d.file_id
         WHERE d.search_text LIKE ? ORDER BY d.name LIMIT ?`,
      )
      .all(`%${trimmed}%`, limit) as Array<Record<string, unknown>>;
    return rows.map(toDefinition);
  }

  /**
   * Row counts, for `/context`, for the acceptance harness, and - the reason this is cached - for
   * the evidence line behind every `absent` verdict.
   *
   * These are four unindexed `COUNT(*)`s, which is nothing on a small project and **25 ms** on a
   * large one: measured at 103k definitions and 635k references, one `code_graph` annotation cost
   * 25 ms against 0.5-0.8 ms on a 411-file repository, and `resolveName` calls this on every
   * single answer. Caching it is not an optimisation of a cold path.
   *
   * Invalidated from two directions, because there are two writers. A write through *this* handle
   * clears the cache directly; a write through the indexing worker's handle is caught by
   * `PRAGMA data_version`, which SQLite changes exactly when another connection commits - and
   * explicitly does **not** change for commits on the same connection, which is why both halves
   * are needed.
   */
  stats(): GraphStats {
    const version = this.dataVersion();
    if (this.cachedStats && this.cachedStats.version === version) return this.cachedStats.stats;

    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    const stats: GraphStats = {
      files: one('SELECT COUNT(*) AS n FROM files'),
      defs: one('SELECT COUNT(*) AS n FROM defs'),
      refs: one('SELECT COUNT(*) AS n FROM refs'),
      calls: one("SELECT COUNT(*) AS n FROM refs WHERE edge_kind = 'call'"),
    };
    this.cachedStats = { version, stats };
    return stats;
  }

  /** Changes whenever another connection commits. Cheap enough to read on every `stats()`. */
  private dataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as { data_version: number } | undefined;
    return Number(row?.data_version ?? 0);
  }

  /** Empties the index, keeping the schema. The graph is derived, so this is always safe. */
  clear(): void {
    this.cachedStats = undefined;
    this.db.exec('DELETE FROM files;');
    this.db.exec('DELETE FROM defs;');
    this.db.exec('DELETE FROM refs;');
    this.db.exec('DELETE FROM imports;');
  }

  /** Folds the WAL back into the main file. Tidiness, not correctness - WAL is durable alone. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close(): void {
    this.db.close();
  }
}

function toIndexedFile(r: Record<string, unknown>): IndexedFile {
  return {
    path: String(r.path),
    language: String(r.language),
    fileHash: String(r.file_hash),
    size: Number(r.size),
    indexedAt: Number(r.indexed_at),
    defCount: Number(r.def_count),
    refCount: Number(r.ref_count),
    indexSeq: Number(r.index_seq),
  };
}

function toDefinition(r: Record<string, unknown>): DefinitionRow {
  return {
    entityUid: String(r.entity_uid),
    path: String(r.path),
    name: String(r.name),
    kind: String(r.kind),
    capture: String(r.capture),
    line: Number(r.line),
    contentHash: String(r.content_hash),
  };
}

function toReference(r: Record<string, unknown>): ReferenceRow {
  return {
    path: String(r.path),
    name: String(r.name),
    kind: String(r.kind),
    capture: String(r.capture),
    edgeKind: String(r.edge_kind) as EdgeKind,
    line: Number(r.line),
  };
}
