import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Runs one shell command for `run_shell` (plan 0006 B20): output collected up to a byte cap, a
 * timeout, and an AbortSignal - and when either fires, the **whole process tree** is killed, not
 * just the shell. With `exec` a cancelled `npm test` left node, the test runner and every watcher
 * it spawned running after Esc; on Windows killing cmd.exe never touches its children at all.
 *
 *  - Windows: `taskkill /pid <shell> /T /F` takes the tree.
 *  - POSIX: the shell starts in its own process group (`detached`), and the group is signalled.
 *
 * Every live child is also killed when o4c itself exits, so a crash or a closed terminal does not
 * leave a build running in the background.
 */

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when killed. */
  code: number | null;
  /** Why it was killed, if it was. */
  killed?: 'timeout' | 'aborted' | 'overflow';
}

export interface ShellOptions {
  /** 0 or negative = no timeout. */
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const live = new Set<ChildProcess>();
const EXIT_GRACE_MS = 500;
let exitHookInstalled = false;

/** Kills a process and everything it started. Synchronous, so it also works from an 'exit' hook. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of live) killTree(child);
  });
}

/** Children still running - for /ps-style reporting and tests. */
export function liveChildren(): number {
  return live.size;
}

export function runShellCommand(command: string, options: ShellOptions): Promise<ShellResult> {
  installExitHook();
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: '', stderr: '', code: null, killed: 'aborted' });
      return;
    }
    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let killed: ShellResult['killed'];
    const stop = (why: NonNullable<ShellResult['killed']>) => {
      if (killed) return;
      killed = why;
      killTree(child);
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBufferBytes) {
        stop('overflow');
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const timer = options.timeoutMs > 0 ? setTimeout(() => stop('timeout'), options.timeoutMs) : undefined;
    const onAbort = () => stop('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      live.delete(child);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        code: killed ? null : code,
        ...(killed ? { killed } : {}),
      });
    };
    child.on('error', (e) => {
      err.push(Buffer.from(String(e.message)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
    // 'close' waits for every process holding the output pipes, so a command that leaves something
    // running in the background ("start server", "cmd &") would hold run_shell open forever. Once
    // the shell itself has exited, give the pipes a moment to drain and then answer anyway.
    child.on('exit', (code) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, EXIT_GRACE_MS).unref();
    });
  });
}
