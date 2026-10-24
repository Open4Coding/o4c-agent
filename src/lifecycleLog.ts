/**
 * A synchronous, append-only record of process lifecycle across restarts.
 *
 * o4c restarts itself constantly - `/clear`, `/resume`, `/set-sessionview` and the per-turn reload
 * all work by handing argv to the supervisor and exiting - and until this existed none of it was
 * written down anywhere. A session that died during a restart left no trace at all: the outgoing
 * process logged nothing on its way out, and the incoming one only created its run log once the
 * user typed something, so a child that hung before painting looked exactly like a child that was
 * never spawned.
 *
 * That gap cost a real diagnosis on 2026-10-22 (a `/set-sessionview` restart that locked up, which
 * had to be reconstructed from SQLite WAL side-effects on a directory mtime). Hence three
 * deliberate properties:
 *
 * - **Synchronous.** `process.on('exit')` permits no asynchronous work, and the most interesting
 *   line is the last one before a process dies. `RunLogger` is async and fire-and-forget, which is
 *   right for a transcript and useless for this.
 * - **One file for the whole project, not one per process.** A restart chain is only readable if
 *   the processes write to the same place, in order. `pid` separates them.
 * - **It never throws.** A logging failure must not be able to break startup or shutdown. Every
 *   entry point swallows its errors; a missing lifecycle line is a worse diagnosis, not a worse
 *   session.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIFECYCLE_FILENAME = 'lifecycle.jsonl';

/**
 * Trimmed to the most recent half once it passes this. Six-odd lines per run means this holds
 * thousands of restarts, which is far more than any diagnosis needs, and the file is append-only
 * so without a cap it would grow for the life of the project.
 */
export const LIFECYCLE_MAX_BYTES = 256 * 1024;

/**
 * Where a process got to. Ordered the way startup runs, so the **last** phase a pid reached is
 * where it stopped - which is the whole question this file answers.
 *
 * - `start`    - the CLI action began. Carries argv, so a restart's arguments are on the record.
 * - `spawn`    - the supervisor launched a child with these arguments.
 * - `trusted`  - the trust gate returned (it can block on a prompt, so it gets its own phase).
 * - `provider` - the provider is built and the local-server probes are done.
 * - `graph`    - the code graph opened, or declined to.
 * - `render`   - the UI is about to mount. Past here, a hang is visible on screen.
 * - `handoff`  - exiting to restart, with the argv being handed over.
 * - `exit`     - the process is ending, with its code.
 */
export type LifecyclePhase =
  | 'start'
  | 'spawn'
  | 'trusted'
  | 'provider'
  | 'graph'
  | 'render'
  | 'handoff'
  | 'exit';

export interface LifecycleRecord {
  readonly ts: string;
  readonly pid: number;
  readonly phase: LifecyclePhase;
  readonly [key: string]: unknown;
}

/**
 * Appends one line. `logsDir` undefined (no project root) writes nothing, deliberately: the
 * lifecycle of a session with nowhere to put it is not worth creating a directory for.
 */
export function recordLifecycle(
  logsDir: string | undefined,
  phase: LifecyclePhase,
  detail: Record<string, unknown> = {},
): void {
  if (!logsDir) return;
  const path = join(logsDir, LIFECYCLE_FILENAME);
  try {
    mkdirSync(logsDir, { recursive: true });
    trimIfOversized(path);
    const record = { ts: new Date().toISOString(), pid: process.pid, phase, ...detail };
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    // Never throws - see the module comment. There is nothing useful to do with a failure here
    // and plenty to lose by letting it escape into a shutdown path.
  }
}

/** Reads the file back, skipping any line that is not a record. Used by `/context` and by tests. */
export function readLifecycle(logsDir: string | undefined): LifecycleRecord[] {
  if (!logsDir) return [];
  try {
    return readFileSync(join(logsDir, LIFECYCLE_FILENAME), 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as LifecycleRecord;
          return typeof parsed?.phase === 'string' ? [parsed] : [];
        } catch {
          // A torn last line is normal for an append-only file whose writer was killed.
          return [];
        }
      });
  } catch {
    return [];
  }
}

function trimIfOversized(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // not there yet, which is the common case
  }
  if (size <= LIFECYCLE_MAX_BYTES) return;
  const lines = readFileSync(path, 'utf-8').split('\n').filter((line) => line.length > 0);
  writeFileSync(path, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, 'utf-8');
}
