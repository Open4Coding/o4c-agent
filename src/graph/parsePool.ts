/**
 * Parsing on several threads for a full index pass (see `parseWorker.ts` for why).
 *
 * A pool is a convenience, never a requirement: if a worker cannot start or dies, every parse from
 * then on - including the ones it had in hand - is done on the calling thread, the way a pass ran
 * before the pool existed. A pass must not fail because a thread did.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { isUnpackedRuntime, packageRoot } from '../packageRoot.js';
import { grammarDir } from './grammarPaths.js';
import type { ParseReply, ParseRequest, ParseWorkerData } from './parseWorker.js';
import { extractFile, type FileExtraction } from './tags.js';

/** Parse threads for a pass on a machine with `cores` cores: leave room for the UI and the pass itself. */
export function parseThreadsFor(cores: number): number {
  return Math.max(0, Math.min(6, cores - 2));
}

function defaultEntry(): URL {
  // I1: the single-executable build unpacks a bundled worker next to its other files.
  if (isUnpackedRuntime()) return pathToFileURL(join(packageRoot(), 'parseWorker.mjs'));
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './parseWorker.ts' : './parseWorker.js', here);
}

interface Pending {
  readonly request: ParseRequest;
  readonly resolve: (result: FileExtraction) => void;
  readonly reject: (err: Error) => void;
}

export class ParsePool {
  private readonly workers: { worker: Worker; pending: Map<number, Pending> }[] = [];
  private nextId = 0;
  private broken = false;

  constructor(
    size: number,
    options: { entry?: URL; grammarDir?: string; onFallback?: (reason: string) => void } = {},
  ) {
    this.onFallback = options.onFallback;
    const data: ParseWorkerData = { parseWorker: true, grammarDir: options.grammarDir ?? grammarDir() };
    try {
      for (let i = 0; i < size; i++) {
        const slot = { worker: new Worker(options.entry ?? defaultEntry(), { workerData: data }), pending: new Map<number, Pending>() };
        slot.worker.on('message', (reply: ParseReply) => {
          const p = slot.pending.get(reply.id);
          if (!p) return;
          slot.pending.delete(reply.id);
          if (reply.ok) p.resolve(reply.result);
          else p.reject(new Error(reply.error));
        });
        const lost = (reason: string) => this.fail(slot, reason);
        slot.worker.on('error', (err) => lost(err.message));
        slot.worker.on('exit', (code) => lost(`a parse worker exited with code ${code}`));
        this.workers.push(slot);
      }
    } catch (err) {
      this.fail(undefined, err instanceof Error ? err.message : String(err));
    }
  }

  private readonly onFallback?: (reason: string) => void;

  /** How many threads are parsing; 0 once the pool has fallen back to the calling thread. */
  get size(): number {
    return this.broken ? 0 : this.workers.length;
  }

  parse(source: string, languageId: string): Promise<FileExtraction> {
    if (this.broken || this.workers.length === 0) return extractFile(source, languageId);
    // The least busy worker: files differ in size by orders of magnitude, so round-robin would
    // queue small files behind a big one while another thread sat idle.
    let slot = this.workers[0]!;
    for (const w of this.workers) if (w.pending.size < slot.pending.size) slot = w;
    const request: ParseRequest = { id: this.nextId++, source, languageId };
    return new Promise<FileExtraction>((resolve, reject) => {
      slot.pending.set(request.id, { request, resolve, reject });
      slot.worker.postMessage(request);
    });
  }

  /** Stops the threads. Idempotent; parses after this run on the calling thread. */
  async close(): Promise<void> {
    const workers = this.workers.splice(0);
    // Set first, so the exits this causes are not taken for failures.
    this.broken = true;
    await Promise.all(workers.map((w) => w.worker.terminate().catch(() => 0)));
  }

  private fail(slot: { worker: Worker; pending: Map<number, Pending> } | undefined, reason: string): void {
    if (!this.broken) this.onFallback?.(reason);
    this.broken = true;
    // Every parse a worker still held is redone here rather than failed: the file is fine, the thread was not.
    const orphans = [...this.workers.flatMap((w) => [...w.pending.values()])];
    for (const w of this.workers) {
      w.pending.clear();
      if (w !== slot) void w.worker.terminate().catch(() => 0);
    }
    for (const p of orphans) extractFile(p.request.source, p.request.languageId).then(p.resolve, p.reject);
  }
}
