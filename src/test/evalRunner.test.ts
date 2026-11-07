import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  defaultEvalDir,
  diffRuns,
  loadTasks,
  parseStats,
  runEvalCli,
  runTask,
  sourceDir,
  statsFromRunLog,
  STATS_MARK,
  summarize,
  type EvalResult,
} from '../eval/evalRunner.js';

function result(task: string, pass: boolean, tokens = 100, wallS = 10): EvalResult {
  return {
    run: 'r',
    task,
    category: 'bug-fix',
    pass,
    exitCode: 0,
    timedOut: false,
    wallS,
    requests: 2,
    inputTokens: tokens - 10,
    outputTokens: 10,
    cachedTokens: 0,
    toolCalls: 3,
    checkTail: '',
    commit: 'abc',
    at: '',
  };
}

test('the shipped eval set: 20 base and 10 hard tasks by default, 6 large-repo ones only when asked', () => {
  const tasks = loadTasks(defaultEvalDir());
  assert.equal(tasks.length, 30);
  assert.equal(loadTasks(defaultEvalDir(), undefined, 'hard').length, 10);
  assert.equal(loadTasks(defaultEvalDir(), undefined, 'base').length, 20);
  for (const t of tasks) {
    assert.ok(t.prompt.length > 20, t.id);
    assert.ok(['bug-fix', 'feature', 'refactor', 'tests', 'multi-file'].includes(t.category), t.id);
  }
  assert.deepEqual(
    loadTasks(defaultEvalDir(), ['03', '07-lru']).map((t) => t.id),
    ['03-batch', '07-lru'],
  );
  const large = loadTasks(defaultEvalDir(), undefined, 'large');
  assert.equal(large.length, 6);
  for (const t of large) {
    assert.equal(t.source?.git, 'https://github.com/microsoft/vscode.git', t.id);
    assert.ok(['navigate', 'refactor', 'bug-fix'].includes(t.category), t.id);
  }
  assert.deepEqual(loadTasks(defaultEvalDir(), ['35']).map((t) => t.id), ['35-large-rename'], 'by id, without the tier');
});

test('parseStats reads the last stats line and survives a missing one', () => {
  const stderr = `noise\n${STATS_MARK}{"requests":1}\nmore\n${STATS_MARK}{"requests":4,"inputTokens":900,"toolCalls":2}\n`;
  assert.deepEqual(parseStats(stderr), { requests: 4, inputTokens: 900, outputTokens: 0, cachedTokens: 0, toolCalls: 2 });
  assert.equal(parseStats('crashed').requests, 0);
});

test('summarize and diffRuns count passes, flips and token change', () => {
  const a = [result('t1', true), result('t2', false), result('t3', true)];
  const b = [result('t1', true, 80), result('t2', true, 80), result('t3', false, 80), result('t4', true)];
  const s = summarize(a);
  assert.equal(s.passed, 2);
  assert.equal(s.inputTokens + s.outputTokens, 300);
  const d = diffRuns('A', a, 'B', b);
  assert.match(d, /t2 .*\+ fixed/);
  assert.match(d, /t3 .*- broke/);
  assert.match(d, /t4 .*\(not run\)/);
  assert.match(d, /on the 3 tasks both ran/);
  assert.match(d, /pass@1 {3}2 -> 2 {2}\(\+1 fixed, -1 broke\)/);
  assert.match(d, /tokens {3}300 -> 240 {2}\(-20\.0%\)/);
});

test('runTask: fresh copy, config written, agent stats parsed, pass script decides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-evalrun-'));
  const taskDir = join(root, 'tasks', '01-x');
  mkdirSync(join(taskDir, 'repo'), { recursive: true });
  writeFileSync(join(taskDir, 'repo', 'a.txt'), 'wrong');
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({ prompt: 'make a.txt say right', category: 'bug-fix' }));
  writeFileSync(
    join(taskDir, 'check.mjs'),
    "import { readFileSync } from 'node:fs'; process.exit(readFileSync('a.txt', 'utf-8') === 'right' ? 0 : 1);",
  );
  // A stand-in agent: does the task, then prints the stats line the way one-shot mode does.
  const agentScript = join(root, 'agent.mjs');
  writeFileSync(
    agentScript,
    `import { writeFileSync } from 'node:fs'; writeFileSync('a.txt', 'right'); process.stderr.write(${JSON.stringify(STATS_MARK)} + JSON.stringify({ requests: 3, inputTokens: 500, outputTokens: 40, toolCalls: 1 }) + '\\n');`,
  );
  const [task] = loadTasks(root);
  const workDir = join(root, 'work');
  const r = await runTask(task, { run: 'unit', workDir, agent: [process.execPath, agentScript], config: { maxIterations: 5 }, commit: 'abc' });
  assert.equal(r.pass, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.requests, 3);
  assert.equal(r.inputTokens, 500);
  assert.equal(r.toolCalls, 1);
  assert.deepEqual(r.config, { maxIterations: 5 });
  assert.deepEqual(JSON.parse(readFileSync(join(workDir, '.o4c', 'config.json'), 'utf-8')), { maxIterations: 5 });
  // The original task files are untouched.
  assert.equal(readFileSync(join(taskDir, 'repo', 'a.txt'), 'utf-8'), 'wrong');

  // An agent that does nothing: the pass script fails, and a second run starts from a fresh copy.
  const idle = join(root, 'idle.mjs');
  writeFileSync(idle, '');
  const r2 = await runTask(task, { run: 'unit', workDir, agent: [process.execPath, idle], commit: 'abc' });
  assert.equal(r2.pass, false);
  assert.equal(r2.requests, 0);
});

test('runTask, large-repo task: pinned commit fetched once, a worktree per run, seed index copied in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-evalsrc-'));
  // The "remote": a repository whose second commit is the pinned one.
  const remote = join(root, 'remote');
  mkdirSync(join(remote, 'src'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(remote, 'init', '-q');
  writeFileSync(join(remote, 'src', 'a.ts'), 'export function oldName() { return 1; }\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-q', '-m', 'one');
  writeFileSync(join(remote, 'src', 'b.ts'), "import { oldName } from './a.js';\nexport const two = oldName() + 1;\n");
  git(remote, 'add', '.');
  git(remote, 'commit', '-q', '-m', 'two');
  const commit = git(remote, 'rev-parse', 'HEAD');
  // A later commit the task must not see.
  writeFileSync(join(remote, 'src', 'c.ts'), 'later\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-q', '-m', 'three');

  const taskDir = join(root, 'tasks', '31-x');
  mkdirSync(join(taskDir, 'repo'), { recursive: true });
  writeFileSync(join(taskDir, 'repo', 'NOTES.md'), 'laid over the commit\n');
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({ prompt: 'rename', category: 'refactor', tier: 'large', source: { git: remote, commit } }));
  writeFileSync(
    join(taskDir, 'check.mjs'),
    `import { atCommit, changedFiles, read } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'eval', 'lib', 'check.mjs')).href)};
     const ok = read('src/a.ts').includes('newName') && atCommit('src/a.ts').includes('oldName')
       && JSON.stringify(changedFiles()) === JSON.stringify(['NOTES.md', 'src/a.ts']);
     console.log(changedFiles());
     process.exit(ok ? 0 : 1);`,
  );
  const agent = join(root, 'agent.mjs');
  writeFileSync(
    agent,
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs'; if (existsSync('src/c.ts') || !existsSync('.o4c/datagraph.db')) process.exit(3); writeFileSync('src/a.ts', readFileSync('src/a.ts', 'utf-8').replace('oldName', 'newName'));",
  );
  const [task] = loadTasks(root, undefined, 'large');
  assert.deepEqual(task.source, { git: remote, commit });
  const cacheDir = join(root, 'cache');
  const logged: string[] = [];
  const opts = { run: 'unit', workDir: join(root, 'work', '31-x'), agent: [process.execPath, agent], commit: 'abc', cacheDir, log: (l: string) => logged.push(l) };
  const r = await runTask(task, opts);
  assert.equal(r.exitCode, 0, 'the agent found the pinned commit (no c.ts) and the seed index');
  assert.equal(r.pass, true, r.checkTail);
  assert.ok(existsSync(sourceDir(cacheDir, task.source!)));
  assert.equal(logged.filter((l) => l.includes('fetching')).length, 1);
  assert.equal(logged.filter((l) => l.includes('indexing')).length, 1);

  // Again in the same place: a fresh worktree, nothing fetched or indexed a second time.
  const r2 = await runTask(task, opts);
  assert.equal(r2.pass, true, r2.checkTail);
  assert.equal(logged.filter((l) => l.includes('fetching')).length, 1);
  assert.equal(logged.filter((l) => l.includes('indexing')).length, 1);
});

test('a source task needs a full commit id', () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-evalsrc-'));
  const taskDir = join(root, 'tasks', '32-y');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'check.mjs'), '');
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({ prompt: 'p', source: { git: 'https://example.invalid/r.git', commit: 'abc123' } }));
  assert.throws(() => loadTasks(root), /full 40-character "commit"/);
});

test('o4c eval list prints every task; an unknown subcommand prints usage', async () => {
  const lines: string[] = [];
  assert.equal(await runEvalCli(['list'], (l) => lines.push(l)), 0);
  assert.equal(lines.length, 30);
  const usage: string[] = [];
  assert.equal(await runEvalCli(['nope'], (l) => usage.push(l)), 2);
  assert.match(usage.join('\n'), /o4c eval run/);
});

test('o4c eval run --help prints usage and runs nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-eval-help-'));
  const lines: string[] = [];
  assert.equal(await runEvalCli(['run', '--help', '--dir', dir], (l) => lines.push(l)), 0);
  assert.ok(lines.some((l) => l.includes('o4c eval run')));
  assert.equal(existsSync(join(dir, 'results')), false);
  assert.equal(await runEvalCli(['diff', '-h'], () => {}), 0);
});

test('a run killed at the timeout is counted from its FULLCONTEXT log, not as 0 tokens', () => {
  const work = mkdtempSync(join(tmpdir(), 'o4c-eval-log-'));
  assert.equal(statsFromRunLog(work), undefined);
  mkdirSync(join(work, '.o4c', 'logs'), { recursive: true });
  const row = (type: string, input: number, calls: number) =>
    JSON.stringify({ type, response: { usage: { inputTokens: input, outputTokens: 10, cachedTokens: input - 5 }, toolCalls: Array(calls).fill({}) } });
  const lines = [row('provider_call', 100, 1), row('provider_call_delta', 200, 2), JSON.stringify({ type: 'note' }), '{"type":"provider_ca'];
  writeFileSync(join(work, '.o4c', 'logs', 'x.FULLCONTEXT.jsonl'), lines.join(String.fromCharCode(10)));
  assert.deepEqual(statsFromRunLog(work), { requests: 2, inputTokens: 300, outputTokens: 20, cachedTokens: 290, toolCalls: 3 });
});
