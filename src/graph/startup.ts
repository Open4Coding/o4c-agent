/**
 * Starting the Code Graph for a session - the wiring, kept out of `cli.ts`.
 *
 * Deliberately shaped like `src/mcp/startup.ts`: one function that either returns a live session
 * or returns `undefined` and says why, so the caller has no branches to get wrong and no way to
 * half-start it. Every failure here costs the graph and nothing else - a session with no index is
 * exactly the session o4c shipped before this existed.
 */

import { join } from 'node:path';

import { GRAPH_DB_FILENAME, GraphStore, migrateLegacyIndex } from './graphStore.js';
import { CodeGraphComponent } from './toolHook.js';
import { createWorkerPass } from './indexPass.js';
import { createCodeGraphTool } from '../tools/codeGraph.js';
import { dbDirFor } from '../session/projectContext.js';
import type { Tool } from '../tools/types.js';

export interface CodeGraphSessionOptions {
  /**
   * The **trusted** project root, or `undefined` for no graph at all.
   *
   * Untrusted gets nothing, the same rule `ConfigStore` and `startMcpSession` are given. The
   * stakes are lower here - indexing parses files, it never executes them - but the index is
   * written into the project's own `.o4c/db/`, and creating a database inside a directory the
   * user has not yet trusted is not something to do on their behalf.
   */
  readonly projectRoot: string | undefined;
  /** Adds the one verb to the loop, exactly as MCP adds its proxies. */
  readonly addTools: (tools: readonly Tool[]) => void;
}

export interface CodeGraphSession {
  readonly component: CodeGraphComponent;
  /** Resolves when the first full pass finishes. Nothing in the app awaits it. */
  readonly ready: Promise<void>;
  close(): void;
}

/**
 * Opens the index, registers the tool, and starts the first pass in the background.
 *
 * The pass is **not** awaited, for the same reason MCP discovery is not: the first prompt should
 * be answerable immediately, and until the pass lands every projection reports `incomplete`, so
 * the window is stated rather than hidden. Since 2026-10-22 it also runs in a worker, so the
 * window costs the index's freshness and no longer costs the UI its frame rate.
 */
export function startCodeGraph(options: CodeGraphSessionOptions): CodeGraphSession | undefined {
  const dbDir = dbDirFor(options.projectRoot);
  if (!dbDir || !options.projectRoot) return undefined;

  // Before the store opens, or it would create an empty database beside the old one and the
  // rename would then be skipped forever.
  migrateLegacyIndex(dbDir);

  let store: GraphStore;
  try {
    store = new GraphStore(join(dbDir, GRAPH_DB_FILENAME));
  } catch {
    // No index is a supported state; a session that will not start because SQLite would not open
    // is not. Silent because there is nothing the user can act on and nothing is degraded that
    // they had before.
    return undefined;
  }

  // Full passes run in a worker. Measured on openai/codex (5,893 files): 42.9 s of parsing that
  // blocked this thread for 27.7 s in total, with a worst stall of 416 ms. See `indexWorker.ts`.
  const pass = createWorkerPass();
  const component = new CodeGraphComponent(store, options.projectRoot, pass);
  options.addTools([createCodeGraphTool(component)]);
  const ready = component.reindex();

  return {
    component,
    ready,
    // No startup notice, on purpose. A failed pass is not silent - it leaves the component in
    // `failed`, which reports `incomplete` to the resolver, which turns every answer that would
    // have claimed absence into `degraded` with a note saying so. That is what the four-state
    // verdict is for, and it reports the failure at the moment it would mislead someone rather
    // than in a startup line nobody reads. `component.status()` is there for `/context` to show
    // when there is a place to show it (checklist item 3's territory, with the worker).
    close(): void {
      // The worker first: a pass in flight is writing to the file about to be checkpointed, and
      // the index is derived, so abandoning a half-finished pass costs nothing but the next
      // session's first pass having more to do.
      pass.terminate();
      try {
        store.checkpoint();
      } catch {
        // WAL is durable on its own; folding it back is tidiness, and failing at it is not worth
        // a message on the way out.
      }
      store.close();
    },
  };
}
