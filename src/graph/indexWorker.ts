/**
 * The indexing worker's entry point - one full pass, off the UI thread, then exit.
 *
 * ## Why there is a worker at all, in numbers
 *
 * A full pass is I/O plus tree-sitter parsing, and the parsing does not yield. Measured on this
 * machine with the product code:
 *
 * | repository | files indexed | cold pass | warm pass |
 * |---|---|---|---|
 * | o4c-agent | 188 | 0.98 s | 0.06 s |
 * | repomix | 411 | 1.42 s | 0.13 s |
 * | openai/codex | 5,893 | **42.9 s** | 1.47 s |
 *
 * On the two small repositories the event-loop lag never exceeded 78 ms and nothing stalled past
 * 100 ms, so a worker would have been machinery for no gain. On codex the same pass blocked the
 * loop for **27.7 s in total**, with 35 stalls over 100 ms and a worst case of **416 ms** - which
 * on the main thread is a visibly frozen TUI and a stalled agent loop, for three quarters of a
 * minute. That is the case this exists for.
 *
 * (A figure of 18.7 s for repomix was recorded on 2026-10-22 and does **not** reproduce: the same
 * harness on the same repository now measures 1.42 s, while the warm figure reproduces exactly.
 * It was almost certainly first-touch grammar loading - 25 MB of WASM, cold file cache - or
 * machine load, not parsing. The codex figures replace it as the ceiling.)
 *
 * ## What it does not do
 *
 * It does not own the store. It opens its own handle on the same SQLite file and writes through
 * it, which WAL supports: one writer and any number of readers, so the main thread keeps
 * answering projections throughout. Two *writers* do now exist, because `read_file` and
 * `write_file` index the bytes they are holding on the main thread, and that is handled in two
 * places rather than here - `busy_timeout` in `GraphStore`, and the sweep in `indexProject`
 * refusing to remove a file indexed since the pass began.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { GraphStore } from './graphStore.js';
import { indexProject, type FileOutcome, type IndexRunResult } from './indexer.js';
import { setGrammarDir } from './grammarPaths.js';

/** What the host sends. Kept to plain data - a worker boundary is a serialisation boundary. */
export interface IndexWorkerRequest {
  readonly dbPath: string;
  readonly root: string;
  /** The host's grammar directory, so an overridden one is not lost across the boundary. */
  readonly grammarDir?: string;
}

/**
 * What comes back.
 *
 * `outcomes` is a plain array rather than the `Map` `IndexRunResult` carries, because the
 * structured clone of a `Map` is fine but the shape should be explicit at a boundary this is the
 * only writer of.
 */
export interface IndexWorkerResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly indexed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly outcomes: ReadonlyArray<readonly [FileOutcome, number]>;
  readonly failures: readonly string[];
  readonly elapsedMs: number;
}

export function toResponse(run: IndexRunResult): IndexWorkerResponse {
  return {
    ok: true,
    indexed: run.indexed,
    unchanged: run.unchanged,
    removed: run.removed,
    outcomes: [...run.outcomes],
    failures: run.failures,
    elapsedMs: run.elapsedMs,
  };
}

export function fromResponse(response: IndexWorkerResponse): IndexRunResult {
  return {
    indexed: response.indexed,
    unchanged: response.unchanged,
    removed: response.removed,
    outcomes: new Map(response.outcomes),
    failures: response.failures,
    elapsedMs: response.elapsedMs,
  };
}

async function main(): Promise<void> {
  const request = workerData as IndexWorkerRequest;
  if (!parentPort) return;

  if (request.grammarDir) setGrammarDir(request.grammarDir);

  let store: GraphStore | undefined;
  try {
    store = new GraphStore(request.dbPath);
    parentPort.postMessage(toResponse(await indexProject(store, request.root)));
  } catch (err) {
    // Reported rather than thrown, so the host gets one message shape to handle and can fall
    // back to indexing in-process. A worker that dies silently would leave the index empty with
    // no phase change, which is the one outcome the four-state verdict cannot describe.
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      indexed: 0,
      unchanged: 0,
      removed: 0,
      outcomes: [],
      failures: [],
      elapsedMs: 0,
    } satisfies IndexWorkerResponse);
  } finally {
    store?.close();
  }
}

// `workerData` is only set when this module really is a worker entry; importing it for the type
// helpers must not start a pass.
if (parentPort && workerData && typeof (workerData as IndexWorkerRequest).dbPath === 'string') {
  void main();
}
