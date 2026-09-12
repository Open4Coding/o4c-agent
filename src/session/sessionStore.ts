import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/types.js';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionData extends SessionMeta {
  messages: Message[];
}

const MAX_SESSIONS = 20;
const TITLE_MAX_LENGTH = 50;

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
 * (not cwd-scoped), capped at MAX_SESSIONS with oldest-pruning, no session file exists until the
 * first real save.
 */
export class SessionStore {
  constructor(private dir: string = defaultSessionsDir()) {}

  private manifestPath(): string {
    return join(this.dir, 'index.json');
  }

  private sessionPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Manifest entries, newest-first. Empty if no sessions have ever been saved. */
  async readManifest(): Promise<SessionMeta[]> {
    try {
      const raw = await readFile(this.manifestPath(), 'utf-8');
      return JSON.parse(raw) as SessionMeta[];
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  private async writeManifest(entries: SessionMeta[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.manifestPath(), JSON.stringify(entries, null, 2), 'utf-8');
  }

  /**
   * Create (if `id` is omitted or unknown) or update (if `id` matches an existing session) a
   * session's persisted content, bubbling it to the top of the manifest as the most recent.
   * Returns the session id - callers without one yet (a brand-new session) need it back to pass
   * into subsequent saves for the same session.
   */
  async save(messages: readonly Message[], id?: string): Promise<string> {
    if (messages.length === 0) {
      throw new Error('SessionStore.save: refusing to persist a session with no messages');
    }

    const now = new Date().toISOString();
    const manifest = await this.readManifest();
    const existing = id ? manifest.find((m) => m.id === id) : undefined;
    const sessionId = existing?.id ?? id ?? randomUUID();
    const firstUserMessage = messages.find((m) => m.role === 'user')?.content ?? '';

    const meta: SessionMeta = {
      id: sessionId,
      title: existing?.title ?? deriveTitle(firstUserMessage),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messageCount: messages.length,
    };

    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.sessionPath(sessionId),
      JSON.stringify({ ...meta, messages }, null, 2),
      'utf-8',
    );

    let updated = [meta, ...manifest.filter((m) => m.id !== sessionId)];
    if (updated.length > MAX_SESSIONS) {
      const pruned = updated.slice(MAX_SESSIONS);
      updated = updated.slice(0, MAX_SESSIONS);
      await Promise.all(pruned.map((p) => rm(this.sessionPath(p.id), { force: true })));
    }
    await this.writeManifest(updated);

    return sessionId;
  }

  /** Full session content (metadata + messages), or undefined if no session has this id. */
  async load(id: string): Promise<SessionData | undefined> {
    try {
      const raw = await readFile(this.sessionPath(id), 'utf-8');
      return JSON.parse(raw) as SessionData;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Permanently removes a session's file and manifest entry. No-op if it doesn't exist. */
  async delete(id: string): Promise<void> {
    await rm(this.sessionPath(id), { force: true });
    const manifest = await this.readManifest();
    const updated = manifest.filter((m) => m.id !== id);
    if (updated.length !== manifest.length) {
      await this.writeManifest(updated);
    }
  }
}
