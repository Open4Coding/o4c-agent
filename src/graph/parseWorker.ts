/**
 * One parse worker of a `ParsePool`: source text in, tags and import bindings out.
 *
 * A full index pass spends about 55% of its time in tree-sitter's parse (VS Code, 15,902 files:
 * 132 s in one thread, 2026-11-07), and the wasm runtime is single-threaded, so the only way to
 * use more than one core is more than one runtime. Each worker loads its own; the reads and the
 * SQLite writes stay with the pass, which is the one place that may write the database.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { setGrammarDir } from './grammarPaths.js';
import { extractFile, type FileExtraction } from './tags.js';

export interface ParseWorkerData {
  readonly parseWorker: true;
  readonly grammarDir?: string;
}

export interface ParseRequest {
  readonly id: number;
  readonly source: string;
  readonly languageId: string;
}

export type ParseReply = { readonly id: number; readonly ok: true; readonly result: FileExtraction } | { readonly id: number; readonly ok: false; readonly error: string };

// Only as a worker entry: importing this module for its types must not start listening.
if (parentPort && (workerData as ParseWorkerData | undefined)?.parseWorker) {
  const port = parentPort;
  const data = workerData as ParseWorkerData;
  if (data.grammarDir) setGrammarDir(data.grammarDir);
  port.on('message', (request: ParseRequest) => {
    extractFile(request.source, request.languageId).then(
      (result) => port.postMessage({ id: request.id, ok: true, result } satisfies ParseReply),
      (err: unknown) => port.postMessage({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ParseReply),
    );
  });
}
