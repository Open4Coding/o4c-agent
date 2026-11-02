import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The eval set (plan 0006 J1): fixture tasks run headless, each checked by its own pass script, so
 * every model-success change reports a measured delta instead of an impression.
 *
 * A task is a directory `eval/tasks/<id>/` holding `task.json` (`prompt`, `category`, optional
 * `timeoutS`), `repo/` (the starting files) and `check.mjs` (exit 0 = pass). The agent only ever sees
 * a fresh copy of `repo/`; the pass script stays outside it, so the model cannot read or edit it.
 */
export interface EvalTask {
  id: string;
  dir: string;
  category: string;
  prompt: string;
  timeoutS: number;
  /** 'base' (the first 20) or 'hard' (J1b: tasks the baseline does not always pass). */
  tier: string;
}

export interface EvalResult {
  run: string;
  task: string;
  category: string;
  pass: boolean;
  /** The agent process's exit code; null when it was killed at the timeout. */
  exitCode: number | null;
  timedOut: boolean;
  wallS: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
  /** The last lines of the pass script's output - why a task failed. */
  checkTail: string;
  commit: string;
  config?: Record<string, unknown>;
  at: string;
}

/** What one-shot mode prints on stderr when it ends (cli.ts), parsed back here. */
export interface RunStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
}

export const STATS_MARK = '--- stats --- ';
export const DEFAULT_TIMEOUT_S = 900;

export function defaultEvalDir(): string {
  // dist/eval/evalRunner.js or src/eval/evalRunner.ts -> the package root's eval/
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval');
}

export function loadTasks(evalDir: string, only?: string[], tier?: string): EvalTask[] {
  const tasksDir = join(evalDir, 'tasks');
  const ids = readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const tasks: EvalTask[] = [];
  for (const id of ids) {
    if (only && only.length > 0 && !only.some((o) => id === o || id.startsWith(`${o}-`))) continue;
    const dir = join(tasksDir, id);
    const spec = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8')) as Partial<EvalTask>;
    if (tier && (spec.tier ?? 'base') !== tier) continue;
    if (typeof spec.prompt !== 'string' || !existsSync(join(dir, 'repo')) || !existsSync(join(dir, 'check.mjs'))) {
      throw new Error(`eval task ${id}: needs task.json with "prompt", repo/ and check.mjs`);
    }
    tasks.push({
      id,
      dir,
      category: spec.category ?? 'other',
      prompt: spec.prompt,
      timeoutS: typeof spec.timeoutS === 'number' ? spec.timeoutS : DEFAULT_TIMEOUT_S,
      tier: spec.tier ?? 'base',
    });
  }
  return tasks;
}

/** The stats line from one-shot mode's stderr; zeros when the run died before printing it. */
export function parseStats(stderr: string): RunStats {
  const zero: RunStats = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, toolCalls: 0 };
  const at = stderr.lastIndexOf(STATS_MARK);
  if (at < 0) return zero;
  try {
    const line = stderr.slice(at + STATS_MARK.length).split('\n')[0];
    return { ...zero, ...(JSON.parse(line) as Partial<RunStats>) };
  } catch {
    return zero;
  }
}

/** Results recorded so far for a run - lets an interrupted run continue where it stopped. */
export function readResults(file: string): EvalResult[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalResult);
}

function tail(text: string, lines = 12): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(command: string, args: string[], cwd: string, timeoutS: number, env?: NodeJS.ProcessEnv): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      // The agent's own run_shell children too, not just the node process.
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    }, timeoutS * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
  });
}

export interface RunTaskOptions {
  run: string;
  /** Where the task's fresh copy goes; removed and recreated. */
  workDir: string;
  /** The agent command; the prompt is appended as the last argument. */
  agent: string[];
  /** Written to the copy's `.o4c/config.json` (project scope), on top of the global config. */
  config?: Record<string, unknown>;
  commit: string;
  timeoutS?: number;
}

export async function runTask(task: EvalTask, options: RunTaskOptions): Promise<EvalResult> {
  rmSync(options.workDir, { recursive: true, force: true });
  mkdirSync(options.workDir, { recursive: true });
  cpSync(join(task.dir, 'repo'), options.workDir, { recursive: true });
  // A .o4c/ marks the copy trusted (no prompt) and holds the per-run config overrides.
  mkdirSync(join(options.workDir, '.o4c'), { recursive: true });
  writeFileSync(join(options.workDir, '.o4c', 'config.json'), JSON.stringify(options.config ?? {}, null, 2));

  const started = Date.now();
  const [command, ...args] = options.agent;
  const agent = await runProcess(command, [...args, task.prompt], options.workDir, options.timeoutS ?? task.timeoutS);
  const wallS = Math.round((Date.now() - started) / 100) / 10;
  const stats = parseStats(agent.stderr);
  const check = await runProcess(process.execPath, [join(task.dir, 'check.mjs')], options.workDir, 300);

  return {
    run: options.run,
    task: task.id,
    category: task.category,
    pass: check.code === 0,
    exitCode: agent.code,
    timedOut: agent.timedOut,
    wallS,
    ...stats,
    checkTail: tail(`${check.stdout}${check.stderr}`),
    commit: options.commit,
    ...(options.config && Object.keys(options.config).length > 0 ? { config: options.config } : {}),
    at: new Date().toISOString(),
  };
}

export interface RunSummary {
  tasks: number;
  passed: number;
  passRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  wallS: number;
  toolCalls: number;
}

export function summarize(results: EvalResult[]): RunSummary {
  const sum = (f: (r: EvalResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const passed = results.filter((r) => r.pass).length;
  return {
    tasks: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cachedTokens: sum((r) => r.cachedTokens),
    wallS: Math.round(sum((r) => r.wallS) * 10) / 10,
    toolCalls: sum((r) => r.toolCalls),
  };
}

export function formatSummary(name: string, s: RunSummary): string {
  return `${name}: pass@1 ${s.passed}/${s.tasks} (${(s.passRate * 100).toFixed(0)}%) · input ${s.inputTokens} · output ${s.outputTokens} · cached ${s.cachedTokens} · tool calls ${s.toolCalls} · wall ${s.wallS} s`;
}

/** Task-by-task comparison of two runs, then the totals; tasks only one run has are marked. */
export function diffRuns(nameA: string, a: EvalResult[], nameB: string, b: EvalResult[]): string {
  const byTask = (rs: EvalResult[]) => new Map(rs.map((r) => [r.task, r]));
  const ma = byTask(a);
  const mb = byTask(b);
  const ids = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const cell = (r: EvalResult | undefined) =>
    r ? `${r.pass ? 'PASS' : 'fail'} ${String(r.inputTokens + r.outputTokens).padStart(7)} tok ${String(r.wallS).padStart(6)} s` : '      (not run)          ';
  const lines = [`${'task'.padEnd(32)} ${nameA.padEnd(28)} ${nameB}`];
  let gained = 0;
  let lost = 0;
  for (const id of ids) {
    const ra = ma.get(id);
    const rb = mb.get(id);
    let mark = '';
    if (ra && rb && ra.pass !== rb.pass) {
      mark = rb.pass ? '  + fixed' : '  - broke';
      if (rb.pass) gained++;
      else lost++;
    }
    lines.push(`${id.padEnd(32)} ${cell(ra).padEnd(28)} ${cell(rb)}${mark}`);
  }
  const both = ids.filter((id) => ma.has(id) && mb.has(id));
  const sa = summarize(both.map((id) => ma.get(id)!));
  const sb = summarize(both.map((id) => mb.get(id)!));
  const pct = (x: number, y: number) => (x ? `${(((y - x) / x) * 100).toFixed(1)}%` : 'n/a');
  lines.push('');
  lines.push(`on the ${both.length} tasks both ran:`);
  lines.push(`  pass@1   ${sa.passed} -> ${sb.passed}  (+${gained} fixed, -${lost} broke)`);
  lines.push(`  tokens   ${sa.inputTokens + sa.outputTokens} -> ${sb.inputTokens + sb.outputTokens}  (${pct(sa.inputTokens + sa.outputTokens, sb.inputTokens + sb.outputTokens)})`);
  lines.push(`  output   ${sa.outputTokens} -> ${sb.outputTokens}  (${pct(sa.outputTokens, sb.outputTokens)})`);
  lines.push(`  wall     ${sa.wallS} -> ${sb.wallS} s  (${pct(sa.wallS, sb.wallS)})`);
  lines.push(`  tools    ${sa.toolCalls} -> ${sb.toolCalls}`);
  return lines.join('\n');
}

function gitCommit(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function resultsFile(evalDir: string, name: string): string {
  return join(evalDir, 'results', name.endsWith('.jsonl') ? name : `${name}.jsonl`);
}

const USAGE = `usage:
  o4c eval run [--tasks id,id] [--tier base|hard] [--name run] [--config json|file] [--timeout s] [--dir eval] [-- o4c flags]
  o4c eval diff <runA> <runB> [--dir eval]
  o4c eval list [--dir eval]

run    each task headless in a fresh copy, then its pass script; one line per task in
       eval/results/<run>.jsonl. Re-running the same --name skips tasks already recorded.
diff   task-by-task and total comparison of two runs.`;

/** `o4c eval ...` - returns the process exit code. */
export async function runEvalCli(argv: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const dashdash = argv.indexOf('--');
  const own = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
  const passThrough = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
  const flag = (name: string) => {
    const i = own.indexOf(`--${name}`);
    return i >= 0 ? own[i + 1] : undefined;
  };
  const positional = own.filter((a, i) => !a.startsWith('--') && !(i > 0 && own[i - 1].startsWith('--')));
  const evalDir = resolve(flag('dir') ?? defaultEvalDir());
  const sub = positional[0];

  if (sub === 'list') {
    for (const t of loadTasks(evalDir)) out(`${t.id.padEnd(32)} ${t.category.padEnd(12)} ${t.prompt.slice(0, 70)}`);
    return 0;
  }

  if (sub === 'diff') {
    const [a, b] = positional.slice(1);
    if (!a || !b) {
      out(USAGE);
      return 2;
    }
    out(diffRuns(a, readResults(resultsFile(evalDir, a)), b, readResults(resultsFile(evalDir, b))));
    return 0;
  }

  if (sub === 'run') {
    // The build being measured - which may be another checkout's dist-eval/, not this eval dir's.
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    const commit = gitCommit(dirname(cli));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const name = flag('name') ?? `${stamp}-${commit}`;
    const configArg = flag('config');
    const config = configArg
      ? (JSON.parse(existsSync(configArg) ? readFileSync(configArg, 'utf-8') : configArg) as Record<string, unknown>)
      : undefined;
    const timeout = flag('timeout');
    const tasks = loadTasks(evalDir, flag('tasks')?.split(','), flag('tier'));
    const file = resultsFile(evalDir, name);
    mkdirSync(dirname(file), { recursive: true });
    const done = new Set(readResults(file).map((r) => r.task));
    const agent = [process.execPath, cli, ...passThrough];
    out(`eval run ${name}: ${tasks.length} tasks${done.size ? `, ${done.size} already recorded` : ''} -> ${file}`);
    for (const task of tasks) {
      if (done.has(task.id)) continue;
      out(`  ${task.id} ...`);
      const result = await runTask(task, {
        run: name,
        workDir: join(tmpdir(), 'o4c-eval', name, task.id),
        agent,
        config,
        commit,
        timeoutS: timeout ? Number(timeout) : undefined,
      });
      appendFileSync(file, `${JSON.stringify(result)}\n`);
      out(`  ${task.id} ${result.pass ? 'PASS' : 'fail'} ${result.wallS} s, ${result.inputTokens + result.outputTokens} tokens, ${result.toolCalls} tool calls${result.timedOut ? ' (timed out)' : ''}`);
    }
    out(formatSummary(name, summarize(readResults(file))));
    return 0;
  }

  out(USAGE);
  return 2;
}
