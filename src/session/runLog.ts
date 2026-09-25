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

  constructor(private dir: string = defaultLogsDir()) {}

  /** The log file's path, once the first entry has been written - undefined before that. */
  getFilePath(): string | undefined {
    return this.filePath;
  }

  private ensureFile(): Promise<string> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await mkdir(this.dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = join(this.dir, `${stamp}.jsonl`);
        return this.filePath;
      })();
    }
    return this.initPromise;
  }

  async log(entry: Record<string, unknown>): Promise<void> {
    const path = await this.ensureFile();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await appendFile(path, `${line}\n`, 'utf-8');
  }
}
