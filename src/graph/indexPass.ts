/**
 * Running a full index pass in a worker, with an in-process fallback.
 *
 * The measurements that justify the worker are in `indexWorker.ts`. This is the host half, and
 * its whole job is that **a pass must still happen if the worker cannot start**. Workers are the
 * part of a Node app most likely to break on a packaging change: the entry file has to exist next
 * to the built module, and under `tsx` it is a `.ts` file that needs the loader. Rather than hope,
 * this falls back to indexing in-process and remembers the decision, so a session on a machine
 * where workers do not work is the session o4c shipped last week - slower at startup, not broken.
 */

import { Worker } from 'node:worker_threads';

import type { GraphStore } from './graphStore.js';
import { indexProject, type IndexRunResult } from './indexer.js';
import { grammarDir } from './grammarPaths.js';
import { fromResponse, type IndexWorkerRequest, type IndexWorkerResponse } from './indexWorker.js';

/** Runs one full pass over `root`, updating the index `store` is attached to. */
export type RunIndexPass = (store: GraphStore, root: string) => Promise<IndexRunResult>;

/** Indexes on the calling thread. The fallback, and what every test uses by default. */
export const runIndexPassInProcess: RunIndexPass = (store, root) => indexProject(store, root);

export interface WorkerPassOptions {
  /** Test seam: resolve the worker entry differently, or point at a script that fails. */
  readonly entry?: URL;
  /** Test seam: a hook that observes whether the worker path was used. */
  readonly onFallback?: (reason: string) => void;
}

/**
 * The worker entry, resolved for both the way o4c runs in development and the way it ships.
 *
 * `dist/graph/indexPass.js` sits beside `dist/graph/indexWorker.js`, and `src/graph/indexPass.ts`
 * beside `src/graph/indexWorker.ts`, so the sibling is always right - only the extension differs,
 * and `import.meta.url` says which one is loaded. The same two-worlds problem `grammarPaths.ts`
 * solves for the `.wasm` and `.scm` assets.
 */
function defaultEntry(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './indexWorker.ts' : './indexWorker.js', here);
}

/**
 * A pass runner that uses a worker, falling back permanently to in-process on the first failure.
 *
 * "Permanently" is deliberate. If the worker could not start once, it will not start next time
 * either, and retrying it per pass would mean paying the spawn and the failure on every file
 * write for the life of the session.
 */
export function createWorkerPass(options: WorkerPassOptions = {}): RunIndexPass & { terminate(): void } {
  let broken = false;
  let active: Worker | undefined;

  const run: RunIndexPass = async (store, root) => {
    if (broken) return runIndexPassInProcess(store, root);

    try {
      return await runInWorker(store, root, options, (worker) => (active = worker));
    } catch (err) {
      broken = true;
      active = undefined;
      options.onFallback?.(err instanceof Error ? err.message : String(err));
      return runIndexPassInProcess(store, root);
    }
  };

  return Object.assign(run, {
    /** Stops a pass in flight - for session shutdown, where the index is disposable anyway. */
    terminate(): void {
      void active?.terminate();
      active = undefined;
    },
  });
}

function runInWorker(
  store: GraphStore,
  root: string,
  options: WorkerPassOptions,
  register: (worker: Worker) => void,
): Promise<IndexRunResult> {
  const request: IndexWorkerRequest = { dbPath: store.path, root, grammarDir: grammarDir() };

  return new Promise<IndexRunResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(options.entry ?? defaultEntry(), { workerData: request });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    register(worker);

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };

    worker.on('message', (message: IndexWorkerResponse) => {
      finish(() =>
        message?.ok
          ? resolve(fromResponse(message))
          : reject(new Error(message?.error ?? 'the index worker reported no result')),
      );
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      // Only reached when the worker exited without sending anything - a crash, or a terminate
      // from `close()`. Either way the host must not wait forever on a promise.
      finish(() => reject(new Error(`the index worker exited with code ${code}`)));
    });
  });
}
