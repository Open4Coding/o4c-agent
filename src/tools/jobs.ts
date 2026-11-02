import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from './types.js';

/**
 * Background jobs for `run_shell` (plan 0006 B22): a dev server, a long build, a watcher - started,
 * left running, read later.
 *
 * o4c reloads its process after most turns, so a job cannot be a child of the process that started
 * it. Each job runs under a small detached Node wrapper that sends the command's output to a log
 * file and, when the command ends, writes its exit code to a second file. The job's record lives in
 * `.o4c/jobs/<id>.json`, so the next process (after a reload) still knows about it.
 *
 * Owned by the process that will really quit: the supervisor when there is one (a reload is the
 * supervisor starting a new worker), else this process. The owner kills its jobs when it exits, so
 * quitting o4c does not leave a dev server running.
 */

export interface JobRecord {
  id: string;
  command: string;
  pid: number;
  log: string;
  exitFile: string;
  ownerPid: number;
  startedAt: number;
  /** Set once the model has been told the job finished. */
  reported?: boolean;
}

export interface JobStatus {
  state: 'running' | 'exited' | 'gone';
  code?: number | null;
  endedAt?: number;
}

const WRAPPER = [
  "const [cmd, log, exitFile] = process.argv.slice(1);",
  "const fs = require('fs');",
  "const out = fs.openSync(log, 'a');",
  "const done = (code, signal) => { try { fs.writeFileSync(exitFile, JSON.stringify({ code, signal, endedAt: Date.now() })); } catch {} process.exit(0); };",
  "const c = require('child_process').spawn(cmd, { shell: true, stdio: ['ignore', out, out], windowsHide: true });",
  "c.on('exit', done);",
  "c.on('error', (e) => { fs.appendFileSync(log, String(e && e.message)); done(-1, null); });",
].join('\n');

let jobsDir: string | undefined;

/** Where job records and logs go: `.o4c/jobs` in a trusted project, else a temp directory. */
export function setJobsDir(dir: string | undefined): void {
  jobsDir = dir;
}

/** The process that will really quit: the supervisor for a reloading worker, else this one. */
export function ownerPid(): number {
  return process.env.O4C_WORKER === '1' ? process.ppid : process.pid;
}

function dir(): string {
  if (!jobsDir) throw new Error('background jobs are not available here (no jobs directory)');
  mkdirSync(jobsDir, { recursive: true });
  return jobsDir;
}

export function listJobs(): JobRecord[] {
  if (!jobsDir || !existsSync(jobsDir)) return [];
  return readdirSync(jobsDir)
    .filter((f) => /^j\d+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(jobsDir!, f), 'utf-8')) as JobRecord;
      } catch {
        return undefined;
      }
    })
    .filter((j): j is JobRecord => !!j)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function getJob(id: string): JobRecord | undefined {
  return listJobs().find((j) => j.id === id);
}

function save(job: JobRecord): void {
  writeFileSync(join(dir(), `${job.id}.json`), JSON.stringify(job, null, 2));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function jobStatus(job: JobRecord): JobStatus {
  if (existsSync(job.exitFile)) {
    try {
      const e = JSON.parse(readFileSync(job.exitFile, 'utf-8')) as { code: number | null; endedAt: number };
      return { state: 'exited', code: e.code, endedAt: e.endedAt };
    } catch {
      return { state: 'exited' };
    }
  }
  return alive(job.pid) ? { state: 'running' } : { state: 'gone' };
}

export function startJob(command: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): JobRecord {
  const d = dir();
  const next = listJobs().reduce((m, j) => Math.max(m, Number(j.id.slice(1))), 0) + 1;
  const id = `j${next}`;
  const log = join(d, `${id}.log`);
  const exitFile = join(d, `${id}.exit.json`);
  writeFileSync(log, '');
  const child = spawn(process.execPath, ['-e', WRAPPER, command, log, exitFile], {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const job: JobRecord = { id, command, pid: child.pid ?? -1, log, exitFile, ownerPid: ownerPid(), startedAt: Date.now() };
  save(job);
  return job;
}

/** Kills a job and everything it started. */
export function killJob(job: JobRecord): boolean {
  if (jobStatus(job).state !== 'running') return false;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(job.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-job.pid, 'SIGKILL');
  } catch {
    return false;
  }
  if (!existsSync(job.exitFile)) writeFileSync(job.exitFile, JSON.stringify({ code: null, signal: 'killed', endedAt: Date.now() }));
  return true;
}

/** Kills every running job this process owns - its exit hook. Synchronous. */
export function killOwnedJobs(pid = process.pid): void {
  for (const job of listJobs()) if (job.ownerPid === pid) killJob(job);
}

/** The last `lines` lines of a job's log, read from the end so a huge log costs nothing. */
export function jobTail(job: JobRecord, lines = 50): string {
  if (!existsSync(job.log)) return '';
  const size = statSync(job.log).size;
  const want = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(want);
  const fd = openSync(job.log, 'r');
  try {
    readSync(fd, buf, 0, want, size - want);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf-8').split('\n');
  return text.slice(-lines - 1).join('\n').trim();
}

export function describeJob(job: JobRecord): string {
  const s = jobStatus(job);
  const state = s.state === 'running' ? 'running' : s.state === 'exited' ? `exited (code ${s.code ?? 'killed'})` : 'gone';
  return `${job.id}  ${state.padEnd(18)} ${job.command}`;
}

/** Jobs that finished and have not been mentioned to the model yet - the turn note (B22). */
export function unreportedFinished(): JobRecord[] {
  const out: JobRecord[] = [];
  for (const job of listJobs()) {
    if (job.reported || jobStatus(job).state === 'running') continue;
    job.reported = true;
    save(job);
    out.push(job);
  }
  return out;
}

export const jobOutputTool: Tool = {
  name: 'job_output',
  description: 'Read a background job started with run_shell background:true: its state and the last lines of its output. Without "id", lists all jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Job id, e.g. "j1".' },
      lines: { type: 'number', description: 'How many of the last output lines (default 50).' },
    },
  },
  async execute(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      const jobs = listJobs();
      return jobs.length ? jobs.map(describeJob).join('\n') : 'No background jobs.';
    }
    const job = getJob(id);
    if (!job) return `Error: no background job "${id}". ${listJobs().length ? `Jobs: ${listJobs().map((j) => j.id).join(', ')}.` : 'There are none.'}`;
    const lines = typeof input.lines === 'number' && input.lines > 0 ? Math.min(input.lines, 500) : 50;
    return `${describeJob(job)}\n--- last ${lines} lines of ${job.log} ---\n${jobTail(job, lines) || '(no output yet)'}`;
  },
};
