import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultLogsDir(): string {
  return join(homedir(), '.o4c', 'logs');
}

/**
 * Records the full, untruncated agent-event stream (tool calls, tool results, model text) as
 * newline-delimited JSON, one file per process run. The REPL itself only ever shows a capped
 * number of lines per turn (see App.tsx) - a codebase-exploration turn that reads dozens of
 * files would otherwise flood the terminal. This is where the full detail actually goes, so
 * nothing is lost even when the screen shows a collapsed summary.
 */
export class RunLogger {
  private filePath: string | undefined;
  // Memoizes the in-flight *initialization* itself, not just its eventual result - callers
  // never await log() (App.tsx's `void runLogger.log(...)` is deliberately fire-and-forget for
  // every event), so several calls can genuinely be concurrent. Checking only `this.filePath`
  // before it's set is a check-then-act race: multiple concurrent calls could each see it unset
  // before the first one's `await mkdir()` resolves, each compute a different timestamp, and
  // split writes across separate files - some events silently landing in a file nothing ever
  // reads back. Awaiting a single shared promise here means only the first call ever does the
  // computation; every other concurrent call awaits that same result instead of racing it.
  private initPromise: Promise<string> | undefined;

  constructor(
    private dir: string = defaultLogsDir(),
    /** Inserted before the `.jsonl` extension (e.g. `'FULLCONTEXT'` ->
     * `<timestamp>.FULLCONTEXT.jsonl`) - lets a second logger share this exact same
     * one-file-per-run naming convention in the same directory without colliding with the
     * first. Omitted (the default, plain event log) keeps the original `<timestamp>.jsonl`. */
    private suffix?: string,
  ) {}

  /** The log file's path, once the first entry has been written - undefined before that. */
  getFilePath(): string | undefined {
    return this.filePath;
  }

  private ensureFile(): Promise<string> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await mkdir(this.dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = join(this.dir, this.suffix ? `${stamp}.${this.suffix}.jsonl` : `${stamp}.jsonl`);
        return this.filePath;
      })();
    }
    return this.initPromise;
  }

  /**
   * Must never reject. Every caller is fire-and-forget (`void runLogger.log(...)` in App.tsx -
   * never awaited, never caught), so a rejection here becomes an unhandled promise rejection -
   * and Node >=15 kills the whole process on those by default. A `JSON.stringify` throw is a
   * real risk, not hypothetical: the FULLCONTEXT log's `provider_call` entries carry a raw
   * provider request/response, not the small display-derived shapes this class originally only
   * ever logged, and a large/unusual one (a circular reference, a BigInt, whatever a future
   * provider's SDK happens to attach) would throw. A disk failure surfacing as a rejection is
   * the same risk from the other side. Swallowing here is the correct degradation - this entry
   * is lost, the session continues, exactly like a full disk already silently loses entries
   * today, just without also killing the process. Best-effort to still leave a trace: writes a
   * minimal one-line marker instead of the entry that failed, itself guarded so a second failure
   * (e.g. the disk failure case) can't reject either.
   */
  async log(entry: Record<string, unknown>): Promise<void> {
    try {
      const path = await this.ensureFile();
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      await appendFile(path, `${line}\n`, 'utf-8');
    } catch (err) {
      try {
        const path = await this.ensureFile();
        const marker = JSON.stringify({
          ts: new Date().toISOString(),
          type: 'log_write_failed',
          error: err instanceof Error ? err.message : String(err),
        });
        await appendFile(path, `${marker}\n`, 'utf-8');
      } catch {
        // Truly nothing left to do - even the marker write failed (e.g. the disk itself is the
        // problem). Swallow for real this time.
      }
    }
  }
}
