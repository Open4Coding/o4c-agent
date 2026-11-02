import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  defaultEvalDir,
  diffRuns,
  loadTasks,
  parseStats,
  runEvalCli,
  runTask,
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

test('the shipped eval set: 20 base and 10 hard tasks, each with a prompt and a category', () => {
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

test('o4c eval list prints every task; an unknown subcommand prints usage', async () => {
  const lines: string[] = [];
  assert.equal(await runEvalCli(['list'], (l) => lines.push(l)), 0);
  assert.equal(lines.length, 30);
  const usage: string[] = [];
  assert.equal(await runEvalCli(['nope'], (l) => usage.push(l)), 2);
  assert.match(usage.join('\n'), /o4c eval run/);
});
