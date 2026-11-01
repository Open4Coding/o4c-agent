import { join } from 'node:path';

import { dbDirFor } from './projectContext.js';
import { INFINITE_CONTEXT_DB_FILENAME, InfiniteContextStore } from './infiniteContextStore.js';
import { HistoryRecorder } from './historyRecorder.js';

/**
 * Opening the history store for a session - NextUp item 13, checklist A5. Shaped like
 * `src/graph/startup.ts` on purpose: one call that either returns a live session or `undefined`,
 * so the caller cannot half-start it, and every failure costs the history and nothing else. A
 * session with no history is exactly the session o4c shipped before this existed.
 */

export interface HistorySessionOptions {
  /** The **trusted** project root, or `undefined` for no history - the same rule ConfigStore, MCP
   * and the Code Graph get: no database is created inside a directory the user has not trusted. */
  readonly projectRoot: string | undefined;
  readonly sessionId: string;
  /** False while the context window type is `none` - see `HistoryRecorderOptions.enabled`. */
  readonly enabled: () => boolean;
}

export interface HistorySession {
  readonly store: InfiniteContextStore;
  readonly recorder: HistoryRecorder;
  close(): void;
}

export function startHistory(options: HistorySessionOptions): HistorySession | undefined {
  const dbDir = dbDirFor(options.projectRoot);
  if (!dbDir || !options.projectRoot) return undefined;
  let store: InfiniteContextStore;
  try {
    store = new InfiniteContextStore(join(dbDir, INFINITE_CONTEXT_DB_FILENAME));
  } catch {
    // Silent, like the graph: nothing the user can act on, and nothing they had before is lost.
    return undefined;
  }
  const recorder = new HistoryRecorder({
    store,
    sessionId: options.sessionId,
    projectRoot: options.projectRoot,
    enabled: options.enabled,
  });
  let closed = false;
  return {
    store,
    recorder,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        store.close();
      } catch {
        // Closing at exit; the WAL is durable without the checkpoint this would have done.
      }
    },
  };
}
