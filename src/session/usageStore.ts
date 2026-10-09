import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The project's lifetime token count, and the current session's share of it, for the footer's
 * token line.
 *
 * Two numbers that cannot come from `AgentLoop` alone. `loop.getUsage()` counts what THIS PROCESS
 * has spent, and a process here is short-lived: o4c reloads itself into a fresh process after most
 * turns (`reloadAfterTurn`, see App.tsx) so the screen can be repainted from saved history. A naive
 * "session total" would therefore reset to zero every turn or two, and a project total would never
 * exist at all. So both are carried on disk, and this process's own spend is added on top.
 *
 * Writes are synchronous, by necessity rather than preference: the save has to happen on the way
 * out, and `process.on('exit')` is the only hook that catches every exit path this app has - it
 * allows no asynchronous work, so an `await`ed write would simply never land.
 */

/** Bumped only if the on-disk shape changes incompatibly. An unrecognised (newer) version makes
 * this store read-only rather than overwriting a format it does not understand. */
export const USAGE_FILE_VERSION = 1;

/** How many sessions' subtotals to keep. Bounded so the file cannot grow without limit, but more
 * than one: concurrent o4c sessions in the same project are a supported case, and a single
 * `session` field would make them clobber each other's running total. */
export const MAX_TRACKED_SESSIONS = 32;

export interface UsageTotals {
  /** Every token this project has ever spent, across all sessions and processes. */
  projectTokens: number;
  /** Tokens for the session on screen, which survives the per-turn reload and `/resume`. */
  sessionTokens: number;
}

interface StoredUsage {
  version: number;
  projectTokens: number;
  /** Session id -> that session's running total. Insertion-ordered, oldest first. */
  sessions: Record<string, number>;
}

function emptyUsage(): StoredUsage {
  return { version: USAGE_FILE_VERSION, projectTokens: 0, sessions: {} };
}

/** A non-negative finite number, or 0. Guards against a hand-edited or half-written file putting
 * `null`, a string or a NaN into a counter that then renders as `NaN` forever. */
function sane(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function parseUsage(text: string): StoredUsage {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const obj = raw as Record<string, unknown>;
  const sessions: Record<string, number> = {};
  if (obj.sessions && typeof obj.sessions === 'object') {
    for (const [id, tokens] of Object.entries(obj.sessions as Record<string, unknown>)) {
      sessions[id] = sane(tokens);
    }
  }
  return {
    version: sane(obj.version) || USAGE_FILE_VERSION,
    projectTokens: sane(obj.projectTokens),
    sessions,
  };
}

/**
 * Reads the stored totals, reports what to display, and writes the new totals back on the way out.
 *
 * Never throws, from either direction. An unreadable or corrupt file starts the count from zero (a
 * display counter is not worth failing a launch over), and a failed write is swallowed (losing one
 * session's count is bad; failing to exit is worse).
 */
export class UsageStore {
  /** What was on disk at startup - the display baseline this process adds its own spend to. */
  private projectBaseline = 0;
  private sessionBaseline = 0;
  private sessionId: string | undefined;
  /** Set when the file is a version we do not understand: read nothing, write nothing. */
  private frozen = false;
  /** `flush()` is called explicitly on the way out AND from `process.on('exit')`, which can both
   * fire for one exit; the second must not double-count this process's spend. */
  private flushed = false;

  /**
   * @param file         where to store the totals (`usageFileFor(projectRoot)`)
   * @param spentThisProcess reads the provider-reported tokens this process has used so far
   */
  constructor(
    private readonly file: string,
    private readonly spentThisProcess: () => number,
  ) {}

  /** Reads the file. `sessionId` is the session being resumed, if any - on a per-turn reload or an
   * explicit `/resume` that is how the session's running total is picked up again. A session id
   * that is not in the file (a brand new session) correctly starts at zero. */
  load(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    let stored: StoredUsage;
    try {
      stored = parseUsage(readFileSync(this.file, 'utf-8'));
    } catch {
      return; // No file yet, or unreadable - start from zero and write one on the way out.
    }
    if (stored.version > USAGE_FILE_VERSION) {
      this.frozen = true;
      return;
    }
    this.projectBaseline = stored.projectTokens;
    this.sessionBaseline = sessionId ? (stored.sessions[sessionId] ?? 0) : 0;
  }

  /** Called when the session acquires an id mid-run (a new session gets one at its first save).
   * Only adopts the stored subtotal for an id we did not already have, so a reload's restored
   * baseline is never re-applied. */
  setSessionId(id: string | undefined): void {
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
  }

  /** What the footer should show right now. Cheap and allocation-light - it is read on render. */
  totals(): UsageTotals {
    const spent = Math.max(0, this.spentThisProcess());
    return {
      projectTokens: this.projectBaseline + spent,
      sessionTokens: this.sessionBaseline + spent,
    };
  }

  /**
   * Writes the totals back. Idempotent: only the first call for a given process counts, so the
   * explicit call on the way out and the `process.on('exit')` backstop cannot double-count.
   *
   * Re-reads the file first and adds this process's spend to whatever is there NOW, rather than to
   * the startup baseline. That is what makes two concurrent o4c sessions in one project additive
   * instead of last-writer-wins.
   */
  flush(): void {
    if (this.flushed || this.frozen) return;
    this.flushed = true;
    const spent = Math.max(0, this.spentThisProcess());
    if (spent === 0) return; // Nothing was spent - no reason to touch the file at all.
    try {
      let current: StoredUsage;
      try {
        current = parseUsage(readFileSync(this.file, 'utf-8'));
      } catch {
        current = emptyUsage();
      }
      if (current.version > USAGE_FILE_VERSION) return; // Appeared since load - leave it alone.
      current.projectTokens += spent;
      if (this.sessionId) {
        const total = (current.sessions[this.sessionId] ?? this.sessionBaseline) + spent;
        // Delete before setting so the touched session moves to the end, making the key order a
        // real recency order for the trim below.
        delete current.sessions[this.sessionId];
        current.sessions[this.sessionId] = total;
        const ids = Object.keys(current.sessions);
        for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_SESSIONS))) {
          delete current.sessions[id];
        }
      }
      current.version = USAGE_FILE_VERSION;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
    } catch {
      // A display counter is never worth failing an exit over.
    }
  }
}
