import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Background sessions (plan 0006 L1): more than one session at once in one o4c window. The one on
 * screen is the foreground session; `/session new <task>` starts another that works on its own task
 * in the background, and `/session` lists them - look at what one is doing, stop it, or, once it has
 * finished, open it here and carry on the conversation.
 *
 * A background session is a headless o4c (`--session <id> "<task>"`) under a small detached wrapper,
 * the same way `run_shell` background jobs run (B22): o4c reloads its process after most turns, so
 * nothing that must outlive a turn can be a child of the process that started it. The wrapper sends
 * the output to a log and writes the exit code to a file when it ends; the record lives in
 * `.o4c/sessions-bg/<n>.json`, so the next process still knows about it. Owned by the process that
 * really quits (the supervisor), which stops them when o4c exits.
 *
 * It saves into the same session store as the foreground, so a finished one opens with `/resume`
 * semantics: the whole conversation, ready for the next message.
 */
export interface BackgroundSession {
  n: number;
  sessionId: string;
  task: string;
  pid: number;
  log: string;
  exitFile: string;
  ownerPid: number;
  startedAt: number;
  /** Set once the foreground has said it finished. */
  reported?: boolean;
}

export interface BackgroundState {
  state: 'running' | 'done' | 'failed' | 'stopped' | 'gone';
  code?: number | null;
  endedAt?: number;
}

const WRAPPER = [
  "const [exe, argsJson, log, exitFile] = process.argv.slice(1);",
  "const fs = require('fs');",
  "const out = fs.openSync(log, 'a');",
  "const done = (code, signal) => { try { fs.writeFileSync(exitFile, JSON.stringify({ code, signal, endedAt: Date.now() })); } catch {} process.exit(0); };",
  "const c = require('child_process').spawn(exe, JSON.parse(argsJson), { stdio: ['ignore', out, out], windowsHide: true });",
  "c.on('exit', done);",
  "c.on('error', (e) => { fs.appendFileSync(log, String(e && e.message)); done(-1, null); });",
].join('\n');

export class BackgroundSessions {
  constructor(private readonly dir: string) {}

  private file(n: number): string {
    return join(this.dir, `${n}.json`);
  }

  list(): BackgroundSession[] {
    if (!existsSync(this.dir)) return [];
    const out: BackgroundSession[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), 'utf-8')) as BackgroundSession);
      } catch {
        // A record being written right now; it is listed next time.
      }
    }
    return out.sort((a, b) => a.n - b.n);
  }

  get(n: number): BackgroundSession | undefined {
    return this.list().find((s) => s.n === n);
  }

  private save(s: BackgroundSession): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(s.n), JSON.stringify(s, null, 2));
  }

  /**
   * Starts one. `self` is how to run this o4c again (node + script, or the single executable);
   * `extraArgs` carries the foreground's provider/model choices so the background talks to the same
   * server.
   */
  start(task: string, self: { exe: string; args: string[] }, extraArgs: string[], options: { cwd: string; ownerPid: number; env?: NodeJS.ProcessEnv }): BackgroundSession {
    mkdirSync(this.dir, { recursive: true });
    const n = this.list().reduce((m, s) => Math.max(m, s.n), 0) + 1;
    const sessionId = randomUUID();
    const log = join(this.dir, `${n}.log`);
    const exitFile = join(this.dir, `${n}.exit.json`);
    writeFileSync(log, '');
    const args = [...self.args, ...extraArgs, '--session', sessionId, task];
    const child = spawn(process.execPath, ['-e', WRAPPER, self.exe, JSON.stringify(args), log, exitFile], {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), O4C_WORKER: '', O4C_BACKGROUND_SESSION: String(n) },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const s: BackgroundSession = { n, sessionId, task, pid: child.pid ?? -1, log, exitFile, ownerPid: options.ownerPid, startedAt: Date.now() };
    this.save(s);
    return s;
  }

  state(s: BackgroundSession): BackgroundState {
    if (existsSync(s.exitFile)) {
      try {
        const e = JSON.parse(readFileSync(s.exitFile, 'utf-8')) as { code: number | null; signal?: string; endedAt: number };
        if (e.signal === 'stopped') return { state: 'stopped', endedAt: e.endedAt };
        return { state: e.code === 0 ? 'done' : 'failed', code: e.code, endedAt: e.endedAt };
      } catch {
        return { state: 'failed' };
      }
    }
    return alive(s.pid) ? { state: 'running' } : { state: 'gone' };
  }

  /** Stops one and everything it started. */
  stop(s: BackgroundSession): boolean {
    if (this.state(s).state !== 'running') return false;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(s.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-s.pid, 'SIGKILL');
    } catch {
      return false;
    }
    writeFileSync(s.exitFile, JSON.stringify({ code: null, signal: 'stopped', endedAt: Date.now() }));
    return true;
  }

  /** The owner's exit hook: stop every running one it started. Synchronous. */
  stopOwned(pid: number): void {
    for (const s of this.list()) if (s.ownerPid === pid) this.stop(s);
  }

  /** Finished ones the foreground has not mentioned yet; marks them mentioned. */
  takeFinished(): BackgroundSession[] {
    const out: BackgroundSession[] = [];
    for (const s of this.list()) {
      if (s.reported || this.state(s).state === 'running') continue;
      s.reported = true;
      this.save(s);
      out.push(s);
    }
    return out;
  }

  /** The end of its log, read from the end so a long one costs nothing. */
  tail(s: BackgroundSession, lines = 40): string {
    if (!existsSync(s.log)) return '';
    const size = statSync(s.log).size;
    const want = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(want);
    const fd = openSync(s.log, 'r');
    try {
      readSync(fd, buf, 0, want, size - want);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf-8').split('\n').slice(-lines - 1).join('\n').trim();
  }

  /** One picker row: number, state, how long, the task. */
  describe(s: BackgroundSession, now = Date.now()): string {
    const st = this.state(s);
    const mins = Math.max(0, Math.round(((st.endedAt ?? now) - s.startedAt) / 60_000));
    const state = st.state === 'failed' ? `failed (exit ${st.code ?? '?'})` : st.state;
    const task = s.task.replace(/\s+/g, ' ');
    return `#${s.n}  ${state}, ${mins} min - ${task.length > 70 ? `${task.slice(0, 67)}...` : task}`;
  }
}

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How to run this o4c again: node and the script, or the single executable on its own. */
export function selfCommand(): { exe: string; args: string[] } {
  const script = process.argv[1];
  return script && script !== process.execPath ? { exe: process.execPath, args: [script] } : { exe: process.execPath, args: [] };
}
