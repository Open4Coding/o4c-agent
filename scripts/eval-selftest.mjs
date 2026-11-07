// Checks the eval set itself (plan 0006 J1): every task's pass script must FAIL on the starting
// repo and PASS once the task's reference solution (solution/, plus solution/.delete) is applied.
// A pass script that passes on the untouched repo, or fails on a correct fix, measures nothing.
// A solution can also be a script, solution.mjs, run in the working copy (the large-repo tasks,
// whose fixes touch files too big to keep a copy of). A large-repo task runs in a worktree of its
// cached source; one that is not cached yet is skipped - `o4c eval run --tier large` fetches it.
// Usage: node scripts/eval-selftest.mjs [task-prefix ...]

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'eval');
const tasksDir = join(evalDir, 'tasks');
const cacheDir = process.env.O4C_EVAL_CACHE ?? join(evalDir, '.cache');
// The same naming as evalRunner.ts's sourceDir().
const sourceDir = (s) => join(cacheDir, `${s.git.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('-')}-${s.commit.slice(0, 12)}`);
let skipped = 0;
const only = process.argv.slice(2);
let bad = 0;
for (const id of readdirSync(tasksDir).sort()) {
  if (only.length && !only.some((o) => id.startsWith(o))) continue;
  const dir = join(tasksDir, id);
  const source = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8')).source;
  if (source && !existsSync(join(sourceDir(source), '.git', 'o4c-ready'))) {
    skipped++;
    console.log(`skip ${id}  (source not cached)`);
    continue;
  }
  const work = mkdtempSync(join(tmpdir(), `o4c-eval-self-${id}-`));
  const check = () => spawnSync(process.execPath, [join(dir, 'check.mjs')], { cwd: work, encoding: 'utf-8', timeout: 300000 });
  if (source) {
    rmSync(work, { recursive: true, force: true });
    const git = spawnSync('git', ['-c', 'core.longpaths=true', 'worktree', 'add', '-q', '--detach', work, source.commit], { cwd: sourceDir(source), encoding: 'utf-8' });
    if (git.status !== 0) throw new Error(git.stderr);
  }
  if (existsSync(join(dir, 'repo'))) cpSync(join(dir, 'repo'), work, { recursive: true });
  const before = check();
  let after;
  if (existsSync(join(dir, 'solution'))) {
    cpSync(join(dir, 'solution'), work, { recursive: true, filter: (src) => !src.endsWith('.delete') });
    const del = join(dir, 'solution', '.delete');
    if (existsSync(del)) for (const rel of readFileSync(del, 'utf-8').split('\n').filter(Boolean)) rmSync(join(work, rel));
  }
  if (existsSync(join(dir, 'solution.mjs'))) spawnSync(process.execPath, [join(dir, 'solution.mjs')], { cwd: work, stdio: 'inherit' });
  if (existsSync(join(dir, 'solution')) || existsSync(join(dir, 'solution.mjs'))) after = check();
  const ok = before.status !== 0 && after?.status === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${id}  start: ${before.status === 0 ? 'passes (wrong)' : 'fails'}  solution: ${after ? (after.status === 0 ? 'passes' : 'fails (wrong)') : 'missing'}`);
  if (!ok) console.log(`${before.stdout}${after ? after.stdout + after.stderr : ''}`.replace(/^/gm, '      '));
  if (source) spawnSync('git', ['worktree', 'remove', '--force', work], { cwd: sourceDir(source) });
  rmSync(work, { recursive: true, force: true });
}
console.log(bad ? `${bad} task(s) wrong` : `every task: fails at start, passes with its solution${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(bad ? 1 : 0);
