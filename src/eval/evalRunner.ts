import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_DB_FILENAME, GraphStore } from '../graph/graphStore.js';
import { indexProject } from '../graph/indexer.js';

/**
 * The eval set (plan 0006 J1): fixture tasks run headless, each checked by its own pass script, so
 * every model-success change reports a measured delta instead of an impression.
 *
 * A task is a directory `eval/tasks/<id>/` holding `task.json` (`prompt`, `category`, optional
 * `timeoutS`), `repo/` (the starting files) and `check.mjs` (exit 0 = pass). The agent only ever sees
 * a fresh copy of `repo/`; the pass script stays outside it, so the model cannot read or edit it.
 *
 * A large-repo task (K4c) names a public repository at a pinned commit instead - `"source": {"git":
 * url, "commit": sha}` - and `repo/`, if present, is laid over it. The repository is fetched once
 * into the cache (`O4C_EVAL_CACHE`, default `eval/.cache/`), each run gets its own git worktree of
 * it, and the code graph's index of the commit is built once and copied in, so every task starts
 * the way a real session on a known project does: index warm, only its own edits to re-parse.
 */
export interface EvalTask {
  id: string;
  dir: string;
  category: string;
  prompt: string;
  timeoutS: number;
  /** 'base' (the first 20), 'hard' (J1b: tasks the baseline does not always pass), or 'large'. */
  tier: string;
  /** A large-repo task's starting point, instead of (or under) `repo/`. */
  source?: EvalSource;
}

export interface EvalSource {
  git: string;
  commit: string;
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
    // The large tier fetches a whole repository and runs far longer: only when asked for, by tier or by id.
    if (!tier && !(only && only.length > 0) && spec.tier === 'large') continue;
    const source = spec.source && typeof spec.source.git === 'string' && /^[0-9a-f]{40}$/.test(spec.source.commit ?? '') ? spec.source : undefined;
    if (spec.source && !source) throw new Error(`eval task ${id}: "source" needs "git" and a full 40-character "commit"`);
    if (typeof spec.prompt !== 'string' || !(source || existsSync(join(dir, 'repo'))) || !existsSync(join(dir, 'check.mjs'))) {
      throw new Error(`eval task ${id}: needs task.json with "prompt", repo/ (or "source") and check.mjs`);
    }
    tasks.push({
      id,
      dir,
      category: spec.category ?? 'other',
      prompt: spec.prompt,
      timeoutS: typeof spec.timeoutS === 'number' ? spec.timeoutS : DEFAULT_TIMEOUT_S,
      tier: spec.tier ?? 'base',
      ...(source ? { source } : {}),
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

/**
 * The same numbers counted from the run's FULLCONTEXT log, for a run killed at the timeout: it never
 * printed its stats line, and recording it as 0 tokens made a run whose model looped for 15 minutes
 * look cheaper than one that finished (k4b-on-r1, 22-big-file, 2026-11-03). Every request row
 * carries the provider's usage, so the log is a full account of what was spent.
 */
export function statsFromRunLog(workDir: string): RunStats | undefined {
  const dir = join(workDir, '.o4c', 'logs');
  if (!existsSync(dir)) return undefined;
  const stats: RunStats = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, toolCalls: 0 };
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.FULLCONTEXT.jsonl'))) {
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let row: { type?: string; response?: { usage?: Partial<RunStats>; toolCalls?: unknown[] } };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue; // the last line of a killed run can be cut short
      }
      if (row.type !== 'provider_call' && row.type !== 'provider_call_delta') continue;
      stats.requests++;
      stats.inputTokens += row.response?.usage?.inputTokens ?? 0;
      stats.outputTokens += row.response?.usage?.outputTokens ?? 0;
      stats.cachedTokens += row.response?.usage?.cachedTokens ?? 0;
      stats.toolCalls += row.response?.toolCalls?.length ?? 0;
    }
  }
  return stats.requests > 0 ? stats : undefined;
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

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function defaultCacheDir(evalDir: string): string {
  return process.env.O4C_EVAL_CACHE ?? join(evalDir, '.cache');
}

/** Where a source's clone lives in the cache: one directory per repository and commit. */
export function sourceDir(cacheDir: string, source: EvalSource): string {
  const name = source.git.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('-');
  return join(cacheDir, `${name}-${source.commit.slice(0, 12)}`);
}

/**
 * The cached clone of a source, fetched on first use: only the one commit, at depth 1, so VS Code
 * is a ~90 MB download rather than its whole history. Its checkout is what the seed index is built
 * from; tasks never touch it, they get worktrees.
 */
export function ensureSource(cacheDir: string, source: EvalSource, log: (line: string) => void = () => {}): string {
  const dir = sourceDir(cacheDir, source);
  if (existsSync(join(dir, '.git', 'o4c-ready'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  log(`  fetching ${source.git} @ ${source.commit.slice(0, 12)} ...`);
  git(['init', '-q'], dir);
  git(['config', 'core.longpaths', 'true'], dir);
  // Byte for byte the commit, whatever the machine's autocrlf: the pass scripts compare against it.
  git(['config', 'core.autocrlf', 'false'], dir);
  git(['config', 'core.eol', 'lf'], dir); // `* text=auto` would otherwise check out CRLF on Windows
  git(['remote', 'add', 'origin', source.git], dir);
  git(['fetch', '-q', '--depth', '1', 'origin', source.commit], dir);
  git(['checkout', '-q', '--detach', source.commit], dir);
  // The agent's own .o4c/ is not part of the task; keep it out of `git status` in every worktree.
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '\n.o4c/\n');
  writeFileSync(join(dir, '.git', 'o4c-ready'), new Date().toISOString());
  return dir;
}

/** The code graph's index of a source's commit, built once next to its clone. */
export async function ensureSeedIndex(cacheDir: string, source: EvalSource, log: (line: string) => void = () => {}): Promise<string> {
  const dir = ensureSource(cacheDir, source, log);
  const seed = `${dir}.${GRAPH_DB_FILENAME}`;
  if (existsSync(seed)) return seed;
  log(`  indexing ${dir} for the code graph (once per source) ...`);
  const building = `${seed}.building`;
  rmSync(building, { force: true });
  const store = new GraphStore(building);
  try {
    const result = await indexProject(store, dir);
    log(`  indexed ${result.indexed} files in ${Math.round(result.elapsedMs / 1000)} s`);
  } finally {
    store.close();
  }
  renameSync(building, seed);
  return seed;
}

/** A fresh worktree of the source at `workDir`, replacing whatever an earlier run left there. */
function addWorktree(sourceClone: string, source: EvalSource, workDir: string): void {
  if (existsSync(workDir)) {
    spawnSync('git', ['worktree', 'remove', '--force', workDir], { cwd: sourceClone });
    rmSync(workDir, { recursive: true, force: true });
  }
  git(['worktree', 'prune'], sourceClone);
  mkdirSync(dirname(workDir), { recursive: true });
  git(['worktree', 'add', '-q', '--detach', workDir, source.commit], sourceClone);
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
  /** Where large-repo sources are cached; needed only by tasks with a `source`. */
  cacheDir?: string;
  log?: (line: string) => void;
}

export async function runTask(task: EvalTask, options: RunTaskOptions): Promise<EvalResult> {
  if (task.source) {
    if (!options.cacheDir) throw new Error(`eval task ${task.id}: a "source" task needs a cache directory`);
    const seed = await ensureSeedIndex(options.cacheDir, task.source, options.log);
    addWorktree(sourceDir(options.cacheDir, task.source), task.source, options.workDir);
    mkdirSync(join(options.workDir, '.o4c'), { recursive: true });
    copyFileSync(seed, join(options.workDir, '.o4c', GRAPH_DB_FILENAME));
  } else {
    rmSync(options.workDir, { recursive: true, force: true });
    mkdirSync(options.workDir, { recursive: true });
  }
  if (existsSync(join(task.dir, 'repo'))) cpSync(join(task.dir, 'repo'), options.workDir, { recursive: true });
  // A .o4c/ marks the copy trusted (no prompt) and holds the per-run config overrides.
  mkdirSync(join(options.workDir, '.o4c'), { recursive: true });
  writeFileSync(join(options.workDir, '.o4c', 'config.json'), JSON.stringify(options.config ?? {}, null, 2));

  const started = Date.now();
  const [command, ...args] = options.agent;
  const agent = await runProcess(command, [...args, task.prompt], options.workDir, options.timeoutS ?? task.timeoutS);
  const wallS = Math.round((Date.now() - started) / 100) / 10;
  const printed = parseStats(agent.stderr);
  const stats = printed.requests === 0 ? (statsFromRunLog(options.workDir) ?? printed) : printed;
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
  o4c eval run [--tasks id,id] [--tier base|hard|large] [--name run] [--config json|file] [--timeout s] [--dir eval] [-- o4c flags]
  o4c eval diff <runA> <runB> [--dir eval]
  o4c eval list [--dir eval]

run    each task headless in a fresh copy, then its pass script; one line per task in
       eval/results/<run>.jsonl. Re-running the same --name skips tasks already recorded.
       Large-repo tasks (--tier large) fetch their repository once into O4C_EVAL_CACHE
       (default eval/.cache/) and run in a git worktree of it.
diff   task-by-task and total comparison of two runs.`;

/** `o4c eval ...` - returns the process exit code. */
export async function runEvalCli(argv: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const dashdash = argv.indexOf('--');
  const own = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
  const passThrough = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
  // Before anything else: `o4c eval run --help` used to start a real 30-task run (found 2026-11-03).
  if (own.includes('--help') || own.includes('-h')) {
    out(USAGE);
    return 0;
  }
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
        cacheDir: defaultCacheDir(evalDir),
        log: out,
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
