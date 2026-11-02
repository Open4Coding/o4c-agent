import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getJob, jobOutputTool, jobStatus, killJob, killOwnedJobs, listJobs, setJobsDir, startJob, unreportedFinished } from '../tools/jobs.js';
import { runShellTool } from '../tools/runShell.js';

/** Plan 0006 B22: background jobs that outlive the call, report when done, and die with their owner. */

const dir = mkdtempSync(join(tmpdir(), 'o4c-jobs-'));
setJobsDir(join(dir, 'jobs'));
const script = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return `node "${p}"`;
};
const wait = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return ok();
};

test('run_shell background:true returns at once; the job finishes, its output and exit code are kept', async () => {
  const started = Date.now();
  const out = await runShellTool.execute({ command: script('quick.js', "console.log('building'); setTimeout(() => { console.log('built'); process.exit(3); }, 800);"), background: true });
  assert.ok(Date.now() - started < 3000);
  const id = /background job (j\d+)/.exec(out)![1]!;
  const job = getJob(id)!;
  assert.equal(jobStatus(job).state, 'running');
  assert.ok(await wait(() => jobStatus(job).state === 'exited'), 'finished');
  assert.equal(jobStatus(job).code, 3);
  const read = await jobOutputTool.execute({ id });
  assert.match(read, new RegExp(`^${id}\\s+exited \\(code 3\\)`));
  assert.match(read, /building\nbuilt/);
  // Reported to the model once.
  assert.deepEqual(unreportedFinished().map((j) => j.id), [id]);
  assert.deepEqual(unreportedFinished(), []);
});

test('kill stops a running job and everything it started; the owner kills its own jobs on exit', async () => {
  const forever = script('forever.js', 'setInterval(() => {}, 1000);');
  const job = startJob(forever);
  assert.ok(await wait(() => jobStatus(job).state === 'running'));
  assert.equal(killJob(job), true);
  assert.ok(await wait(() => jobStatus(job).state !== 'running'));
  assert.equal(killJob(job), false, 'not running any more');

  const owned = startJob(forever);
  const foreign = { ...startJob(forever) };
  // Re-own the second one, as if another process had started it.
  writeFileSync(join(dir, 'jobs', `${foreign.id}.json`), JSON.stringify({ ...foreign, ownerPid: 999999 }));
  killOwnedJobs(process.pid);
  assert.ok(await wait(() => jobStatus(owned).state !== 'running'));
  assert.equal(jobStatus(getJob(foreign.id)!).state, 'running', "another owner's job is left alone");
  killJob(getJob(foreign.id)!);
  assert.match(await jobOutputTool.execute({}), new RegExp(`${owned.id}\\s+exited`));
  assert.equal(listJobs().filter((j) => jobStatus(j).state === 'running').length, 0);
});
