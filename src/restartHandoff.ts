import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Exit code a worker uses to tell the supervisor "start me again with the args in the handoff
 * file". 75 is EX_TEMPFAIL from sysexits.h: not a code Node itself or the app uses for anything. */
export const RESTART_EXIT_CODE = 75;

export interface RestartRequest {
  model: string;
  provider: string;
  baseUrl: string;
  image?: string;
  resumeId?: string;
  /** The Auto/Manual/... mode to start in - carried across the restart so a reload never silently
   * drops the user back to Manual. */
  mode?: string;
}

/** The argv (after the script path) a restarted o4c is launched with. */
export function buildRestartArgs(request: RestartRequest): string[] {
  const args = ['-m', request.model, '-p', request.provider, '--base-url', request.baseUrl];
  if (request.image) args.push('--image', request.image);
  if (request.resumeId) args.push('--resume', request.resumeId);
  if (request.mode) args.push('--mode', request.mode);
  return args;
}

export function writeHandoff(path: string, args: string[]): void {
  writeFileSync(path, JSON.stringify({ args }), 'utf-8');
}

/** Reads and deletes the handoff file. Undefined when it is missing or malformed - the supervisor
 * treats that as "no valid restart request" and stops instead of looping on garbage. */
export function readHandoff(path: string): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { args?: unknown };
    rmSync(path, { force: true });
    if (Array.isArray(parsed.args) && parsed.args.every((a) => typeof a === 'string')) {
      return parsed.args as string[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface SupervisorSpawnResult {
  status: number | null;
}

export type SupervisorSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => SupervisorSpawnResult;

export interface SupervisorOptions {
  nodePath: string;
  script: string;
  /** The user's original arguments, used for the first launch only. */
  initialArgs: string[];
  handoffPath: string;
  env: NodeJS.ProcessEnv;
  spawn: SupervisorSpawn;
}

/**
 * The thin launcher the interactive `o4c` runs as. It starts the real app as a child process and
 * waits; when the child exits with `RESTART_EXIT_CODE` it reads the handoff file and starts the
 * next child (the fresh process clears the screen and repaints the session). Because the restart
 * is a loop here instead of a nested spawn inside the app, the number of live processes stays
 * constant however many times the app restarts - a nested spawn parked one idle process per
 * restart. Blocking (spawnSync-style), not fire-and-forget: the parent must stay alive for the
 * terminal handoff, or the shell prompt would interleave with the child's UI.
 *
 * Returns the exit code the supervisor itself should exit with.
 */
export function runSupervisor(options: SupervisorOptions): number {
  let args = options.initialArgs;
  let first = true;
  for (;;) {
    const env: NodeJS.ProcessEnv = {
      ...options.env,
      O4C_WORKER: '1',
      O4C_HANDOFF_FILE: options.handoffPath,
    };
    if (!first) env.O4C_FRESH_SCREEN = '1';
    first = false;
    const result = options.spawn(options.nodePath, [options.script, ...args], { stdio: 'inherit', env });
    if (result.status !== RESTART_EXIT_CODE) {
      rmSync(options.handoffPath, { force: true });
      return result.status ?? 0;
    }
    const next = readHandoff(options.handoffPath);
    if (!next) return 1;
    args = next;
  }
}
