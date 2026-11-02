// Checks the eval set itself (plan 0006 J1): every task's pass script must FAIL on the starting
// repo and PASS once the task's reference solution (solution/, plus solution/.delete) is applied.
// A pass script that passes on the untouched repo, or fails on a correct fix, measures nothing.
// Usage: node scripts/eval-selftest.mjs [task-prefix ...]

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tasksDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'eval', 'tasks');
const only = process.argv.slice(2);
let bad = 0;
for (const id of readdirSync(tasksDir).sort()) {
  if (only.length && !only.some((o) => id.startsWith(o))) continue;
  const dir = join(tasksDir, id);
  const work = mkdtempSync(join(tmpdir(), `o4c-eval-self-${id}-`));
  const check = () => spawnSync(process.execPath, [join(dir, 'check.mjs')], { cwd: work, encoding: 'utf-8', timeout: 120000 });
  cpSync(join(dir, 'repo'), work, { recursive: true });
  const before = check();
  let after;
  if (existsSync(join(dir, 'solution'))) {
    cpSync(join(dir, 'solution'), work, { recursive: true, filter: (src) => !src.endsWith('.delete') });
    const del = join(dir, 'solution', '.delete');
    if (existsSync(del)) for (const rel of readFileSync(del, 'utf-8').split('\n').filter(Boolean)) rmSync(join(work, rel));
    after = check();
  }
  const ok = before.status !== 0 && after?.status === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${id}  start: ${before.status === 0 ? 'passes (wrong)' : 'fails'}  solution: ${after ? (after.status === 0 ? 'passes' : 'fails (wrong)') : 'missing'}`);
  if (!ok) console.log(`${before.stdout}${after ? after.stdout + after.stderr : ''}`.replace(/^/gm, '      '));
  rmSync(work, { recursive: true, force: true });
}
console.log(bad ? `${bad} task(s) wrong` : 'every task: fails at start, passes with its solution');
process.exit(bad ? 1 : 0);
