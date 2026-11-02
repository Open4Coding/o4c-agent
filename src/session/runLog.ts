import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { redactSecrets } from './redact.js';

export function defaultLogsDir(): string {
  return join(homedir(), '.o4c', 'logs');
}

/** How long entries wait in memory before one batched write - design §3.7's 100 ms. */
export const RUN_LOG_DRAIN_MS = 100;

/**
 * Records the full, untruncated agent-event stream (tool calls, tool results, model text) as
 * newline-delimited JSON, one file per process run. The REPL itself only ever shows a capped
 * number of lines per turn (see App.tsx) - a codebase-exploration turn that reads dozens of
 * files would otherwise flood the terminal. This is where the full detail actually goes, so
 * nothing is lost even when the screen shows a collapsed summary.
 *
 * Writes go through a queue (design §3.7, adopted 2026-09-28, built 2026-11-02). Before it, every
 * `log()` did its own fire-and-forget `appendFile`, and a FULLCONTEXT entry can be megabytes - Node
 * writes those in several pieces, and a second append landing between the pieces spliced one
 * entry into the middle of another (a real corrupted log). Now `log()` only queues the line, and
 * one synchronous append per drain writes the whole batch, so there is never more than one write
 * in flight and a line is always written whole. The drain timer is unref'd so a pending drain never
 * keeps the process alive; `flush()` writes whatever is still queued and is called on every exit
 * path (cli.ts), because `process.on('exit')` permits no asynchronous work.
 */
export class RunLogger {
  private filePath: string | undefined;
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private dir: string = defaultLogsDir(),
    /** Inserted before the `.jsonl` extension (e.g. `'FULLCONTEXT'` ->
     * `<timestamp>.FULLCONTEXT.jsonl`) - lets a second logger share this exact same
     * one-file-per-run naming convention in the same directory without colliding with the
     * first. Omitted (the default, plain event log) keeps the original `<timestamp>.jsonl`. */
    private suffix?: string,
    private drainMs: number = RUN_LOG_DRAIN_MS,
  ) {}

  /** The log file's path, once the first entry has been written - undefined before that. */
  getFilePath(): string | undefined {
    return this.filePath;
  }

  private ensureFile(): string {
    if (!this.filePath) {
      mkdirSync(this.dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.filePath = join(this.dir, this.suffix ? `${stamp}.${this.suffix}.jsonl` : `${stamp}.jsonl`);
    }
    return this.filePath;
  }

  /**
   * Queues one entry. Must never throw or reject: every caller is fire-and-forget
   * (`void runLogger.log(...)` in App.tsx), and an unhandled rejection kills the process on
   * Node >= 15. A `JSON.stringify` throw is a real risk - FULLCONTEXT `provider_call` entries carry
   * raw provider payloads, and a circular reference or BigInt would throw - so a failed entry is
   * replaced by a one-line `log_write_failed` marker instead. Still returns a promise (resolved
   * once queued) so existing call sites keep their shape.
   */
  log(entry: Record<string, unknown>): Promise<void> {
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    } catch (err) {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        type: 'log_write_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.queue.push(redactSecrets(line));
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.drainMs);
      this.timer.unref();
    }
    return Promise.resolve();
  }

  /**
   * Writes everything queued, synchronously, in one append. Idempotent and safe to call from
   * `process.on('exit')`. A disk failure loses this batch and nothing else - the session goes on,
   * as a full disk always silently lost entries.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const batch = `${this.queue.join('\n')}\n`;
    this.queue = [];
    try {
      appendFileSync(this.ensureFile(), batch, 'utf-8');
    } catch {
      // Nothing left to do: the disk itself is the problem.
    }
  }
}
