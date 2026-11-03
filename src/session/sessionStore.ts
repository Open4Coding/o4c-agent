import { mkdir, readFile, writeFile, rm, rename as renameFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { redactSecrets } from './redact.js';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/types.js';
import { liftLegacyMessages, toWireMessages, type ContextEntry } from '../agent/contextEntry.js';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Wire-format message count (`toWireMessages(entries).length`), not the raw entry count -
   * keeps this number's meaning stable across the §5.1 refactor (a tool-heavy turn now logs
   * several `ContextEntry` rows per assistant turn, which would otherwise inflate this past what
   * "N messages" has always meant to whoever's reading `/resume`'s picker, SessionPicker.tsx). */
  messageCount: number;
}

export interface SessionData extends SessionMeta {
  entries: ContextEntry[];
  /** The input box's own submit-history (↑/↓ recall) at the time of the last save - optional so
   * older session files saved before this existed still load fine (`InputBox` treats a missing
   * value the same as an empty history). Kept per-session (not global/shell-style) deliberately:
   * `/resume`-ing a session restores what you were typing back then alongside its conversation;
   * `/clear` starts a genuinely fresh session with no id yet, so there's nothing to carry
   * forward, consistent with the conversation itself also starting empty. */
  inputHistory?: string[];
}

// Front-end plan item #9's fallback default when `sessionsToSave` isn't configured - unchanged
// behavior for anyone who never touches the new /set-sessionsToSave family.
export const DEFAULT_MAX_SESSIONS = 20;
const TITLE_MAX_LENGTH = 50;

const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_seq ON sessions(seq);
`;

interface ManifestRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

function fromRow(r: ManifestRow): SessionMeta {
  return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: Number(r.message_count) };
}

export function defaultSessionsDir(): string {
  return join(homedir(), '.o4c', 'sessions');
}

/** First ~50 characters of a message, collapsed to one line, for use as a session's display title. */
export function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '(empty message)';
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Persists sessions as one JSON file per session, plus a manifest (`index.json`) listing the
 * most recent ones for /resume. See docs/frontend-design.md §4.1 for the full design - global
 * (not cwd-scoped), capped at `maxSessions` (configurable, front-end plan item #9's
 * `/set-sessionsToSave` family) with oldest-pruning, no session file exists until the
 * first real save.
 */
export class SessionStore {
  constructor(
    private dir: string = defaultSessionsDir(),
    // Mutable (not readonly), not just a constructor default - /set-sessionsToSave (front-end
    // plan item #9) updates this directly on the live instance for the current process, in
    // addition to persisting the new value via ConfigStore for future launches - the same
    // "immediate + persisted" dual effect /config-highlightcolor already established.
    public maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {}

  /** The pre-F4 manifest, imported once into the database and then renamed `.migrated`. */
  private manifestPath(): string {
    return join(this.dir, 'index.json');
  }

  /**
   * The manifest lives in SQLite (plan 0006 F4) - `.o4c/db/sessions.db` beside the other databases
   * (so /view-db shows it), or inside the sessions folder when that folder is not `.o4c/sessions`
   * (tests, odd layouts). It used to be `index.json`, rewritten whole on every save, so two o4c
   * processes saving at once could each drop the other's entry; a transaction cannot.
   *
   * Opened per operation and closed after: a few milliseconds per save, and nothing held open - an
   * open SQLite file cannot be deleted on Windows, and session folders do get deleted.
   */
  private manifestDbPath(): string {
    return basename(this.dir) === 'sessions' ? join(dirname(this.dir), 'db', 'sessions.db') : join(this.dir, 'sessions.db');
  }

  private async withDb<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const path = this.manifestDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec(SESSIONS_SCHEMA);
      await this.migrateIndexJson(db);
      return fn(db);
    } finally {
      db.close();
    }
  }

  private async migrateIndexJson(db: DatabaseSync): Promise<void> {
    if ((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n > 0) return;
    let old: SessionMeta[];
    try {
      old = JSON.parse(await readFile(this.manifestPath(), 'utf-8')) as SessionMeta[];
    } catch {
      return;
    }
    const insert = db.prepare('INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, message_count, seq) VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      old.forEach((m, i) => insert.run(m.id, m.title, m.createdAt, m.updatedAt, m.messageCount, old.length - i));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    await renameFile(this.manifestPath(), `${this.manifestPath()}.migrated`).catch(() => undefined);
  }

  private sessionPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Manifest entries, newest-first. Empty if no sessions have ever been saved. */
  async readManifest(): Promise<SessionMeta[]> {
    return this.withDb((db) =>
      (db.prepare('SELECT id, title, created_at, updated_at, message_count FROM sessions ORDER BY seq DESC').all() as unknown as ManifestRow[]).map(fromRow),
    );
  }

  /**
   * Create (if `id` is omitted or unknown) or update (if `id` matches an existing session) a
   * session's persisted content, bubbling it to the top of the manifest as the most recent.
   * Returns the session id - callers without one yet (a brand-new session) need it back to pass
   * into subsequent saves for the same session.
   */
  async save(entries: readonly ContextEntry[], id?: string, inputHistory?: readonly string[]): Promise<string> {
    if (entries.length === 0) {
      throw new Error('SessionStore.save: refusing to persist a session with no entries');
    }

    const now = new Date().toISOString();
    const existing = id
      ? await this.withDb((db) => {
          const row = db.prepare('SELECT id, title, created_at, updated_at, message_count FROM sessions WHERE id = ?').get(id) as unknown as ManifestRow | undefined;
          return row ? fromRow(row) : undefined;
        })
      : undefined;
    const sessionId = existing?.id ?? id ?? randomUUID();
    const firstUserEntry = entries.find((e) => e.type === 'user' && e.sub_type === 'input');
    // Stamped in here, not at entry-creation time - AgentLoop itself has no concept of "which
    // session this is" (§5.1, §8.1's "no session created until the first real message").
    const stampedEntries = entries.map((e) => ({ ...e, session_id: sessionId }));

    const meta: SessionMeta = {
      id: sessionId,
      title: existing?.title ?? deriveTitle(firstUserEntry?.content ?? ''),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messageCount: toWireMessages(entries).length,
    };

    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.sessionPath(sessionId),
      redactSecrets(JSON.stringify({ ...meta, entries: stampedEntries, inputHistory }, null, 2)),
      'utf-8',
    );

    // One transaction: this session to the top, and anything past maxSessions out.
    const pruned = await this.withDb((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          `INSERT INTO sessions (id, title, created_at, updated_at, message_count, seq)
           VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sessions))
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
             message_count = excluded.message_count, seq = excluded.seq`,
        ).run(meta.id, meta.title, meta.createdAt, meta.updatedAt, meta.messageCount);
        const old = (db.prepare('SELECT id FROM sessions ORDER BY seq DESC LIMIT -1 OFFSET ?').all(this.maxSessions) as { id: string }[]).map((r) => r.id);
        const del = db.prepare('DELETE FROM sessions WHERE id = ?');
        for (const oldId of old) del.run(oldId);
        db.exec('COMMIT');
        return old;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    });
    await Promise.all(pruned.map((p) => rm(this.sessionPath(p), { force: true })));

    return sessionId;
  }

  /**
   * Full session content (metadata + entries), or undefined if no session has this id. A session
   * file saved before the §5.1 refactor (plain `messages: Message[]`, no `entries`) is lifted into
   * minimal `ContextEntry` objects on the way out - a one-way upgrade path, not a migration that
   * needs to run anywhere (§5.1). The on-disk file itself is left untouched until next saved.
   */
  async load(id: string): Promise<SessionData | undefined> {
    try {
      const raw = await readFile(this.sessionPath(id), 'utf-8');
      const parsed = JSON.parse(raw) as SessionData & { messages?: Message[] };
      if (!parsed.entries && parsed.messages) {
        return { ...parsed, entries: liftLegacyMessages(parsed.messages) };
      }
      return parsed;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Permanently removes a session's file and manifest entry. No-op if it doesn't exist. */
  async delete(id: string): Promise<void> {
    await rm(this.sessionPath(id), { force: true });
    await this.withDb((db) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id));
  }

  /**
   * Overwrites a session's title (`/set-sessionname`), in both the manifest and the session's
   * own file, so /resume's picker and the session's own on-disk record agree. Throws if `id`
   * doesn't match any saved session - callers check that themselves (e.g. "nothing to rename
   * yet") but a rename specifically targeting an id that's gone missing should still surface as
   * an error, not silently no-op like `delete` does.
   */
  async rename(id: string, title: string): Promise<void> {
    const data = await this.load(id);
    if (!data) {
      throw new Error(`No saved session with id "${id}" to rename.`);
    }
    await writeFile(this.sessionPath(id), redactSecrets(JSON.stringify({ ...data, title }, null, 2)), 'utf-8');

    await this.withDb((db) => db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id));
  }
}
