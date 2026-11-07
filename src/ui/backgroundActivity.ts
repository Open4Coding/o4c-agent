import { jobStatus, listJobs, ownerPid, type JobRecord } from '../tools/jobs.js';
import type { CodeGraphStatus } from '../graph/toolHook.js';

/**
 * What o4c is doing that no spinner shows: the footer's `bg:` part (found 2026-11-07 on the VS
 * Code source, where a 5-minute first index pass and a 1.5-minute checkpoint warm-up both ran with
 * nothing on screen, and an idle screen could not be told from a busy one).
 *
 * Only work that runs between and alongside turns belongs here. A turn's own work has the spinner.
 */
export interface BackgroundSources {
  /** The code graph's pass: `building` until the first full pass (or a rebuild) lands. */
  graphPhase?: () => string;
  /** How far that pass has got, when it has said. */
  graphProgress?: () => { readonly done: number; readonly total: number } | undefined;
  /** The checkpoint repository's session-start warm-up. */
  checkpointWarming?: () => boolean;
  /** This session's background jobs (run_shell with background, /ps). */
  jobs?: () => readonly JobRecord[];
}

export function backgroundActivity(sources: BackgroundSources): string[] {
  const parts: string[] = [];
  if (sources.graphPhase?.() === 'building') {
    const progress = sources.graphProgress?.();
    parts.push(progress && progress.total > 0 ? `indexing code ${progress.done.toLocaleString('en-US')}/${progress.total.toLocaleString('en-US')}` : 'indexing code');
  }
  if (sources.checkpointWarming?.()) parts.push('checkpoint prep');
  const running = (sources.jobs?.() ?? []).filter((job) => jobStatus(job).state === 'running').length;
  if (running > 0) parts.push(`${running} job${running === 1 ? '' : 's'}`);
  return parts;
}

/** This session's jobs only: another o4c's jobs are its business, and its footer's. */
export function ownJobs(): JobRecord[] {
  const me = ownerPid();
  return listJobs().filter((job) => job.ownerPid === me);
}

/** Printed when the session's first index pass starts (David's wording, 2026-11-07). */
export const INDEX_START_LINE = '[code graph] running in background, indexing files (bg)';

/** Printed when it ends: how many files the pass went through, and how long it took. */
export function indexDoneLine(status: CodeGraphStatus): string {
  if (status.phase === 'failed') return `[code graph] scan failed: ${status.lastError ?? 'unknown error'}`;
  const run = status.lastRun;
  const files = run ? run.indexed + run.unchanged : 0;
  return `[code graph] completed scan, scanned ${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} (${hms(run?.elapsedMs ?? 0)})`;
}

/** A duration as hh:mm:ss. */
export function hms(ms: number): string {
  const total = Math.round(ms / 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}
