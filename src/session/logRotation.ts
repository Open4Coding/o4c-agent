import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Log rotation (plan 0006 F3): `.o4c/logs` gained one run log (plus its FULLCONTEXT twin) per
 * process, forever. Pruned at startup.
 *
 * The rule is two-sided on purpose. o4c reloads into a fresh process after most turns, so one run
 * log is roughly one TURN, not one session - "keep the last 50 runs" alone would keep about one
 * afternoon and delete the evidence of a long unattended run before anyone looked at it. So a run
 * is kept if it is among the newest `logsToKeep` (default 50) OR younger than `logsKeepDays`
 * (default 7). Only `<stamp>.jsonl` / `<stamp>.FULLCONTEXT.jsonl` are touched; lifecycle.jsonl,
 * crash.log and anything else in the folder are left alone. `logsToKeep: 0` turns pruning off.
 */
export const LOGS_TO_KEEP_KEY = 'logsToKeep';
export const LOGS_KEEP_DAYS_KEY = 'logsKeepDays';

const RUN_LOG = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:\.[A-Z]+)?\.jsonl$/;

/** The run stamp's time: `2026-11-02T10-00-00-000Z` -> ms. */
function stampTime(stamp: string): number {
  const iso = stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  return Date.parse(iso);
}

export function pruneRunLogs(dir: string, keep = 50, keepDays = 7, now = Date.now()): { removed: number; kept: number } {
  if (keep <= 0) return { removed: 0, kept: 0 };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const byStamp = new Map<string, string[]>();
  for (const n of names) {
    const m = RUN_LOG.exec(n);
    if (m) byStamp.set(m[1]!, [...(byStamp.get(m[1]!) ?? []), n]);
  }
  const stamps = [...byStamp.keys()].sort().reverse();
  const cutoff = now - keepDays * 86_400_000;
  let removed = 0;
  let prunedRuns = 0;
  stamps.forEach((stamp, i) => {
    if (i < keep || stampTime(stamp) >= cutoff) return;
    prunedRuns++;
    for (const n of byStamp.get(stamp)!) {
      try {
        rmSync(join(dir, n), { force: true });
        removed++;
      } catch {
        // A file in use (another o4c in this project) stays until next time.
      }
    }
  });
  return { removed, kept: stamps.length - prunedRuns };
}

export function logRotationSettings(config: Record<string, unknown>): { keep: number; keepDays: number } {
  const keep = typeof config[LOGS_TO_KEEP_KEY] === 'number' ? Math.max(0, Math.floor(config[LOGS_TO_KEEP_KEY] as number)) : 50;
  const keepDays = typeof config[LOGS_KEEP_DAYS_KEY] === 'number' ? Math.max(0, config[LOGS_KEEP_DAYS_KEY] as number) : 7;
  return { keep, keepDays };
}
