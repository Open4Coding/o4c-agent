import { jobStatus, listJobs, ownerPid, type JobRecord } from '../tools/jobs.js';

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
