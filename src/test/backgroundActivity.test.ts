import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundActivity } from '../ui/backgroundActivity.js';
import type { JobRecord } from '../tools/jobs.js';

/** The footer's bg: part (2026-11-07): what runs between turns, named; nothing when nothing runs. */

const job = (pid: number): JobRecord => ({ id: 'j1', command: 'x', pid, log: '', exitFile: '/no/such/exit/file', ownerPid: process.pid, startedAt: 0 });

test('each source appears only while it is busy, in a fixed order', () => {
  assert.deepEqual(backgroundActivity({}), []);
  assert.deepEqual(backgroundActivity({ graphPhase: () => 'ready', checkpointWarming: () => false, jobs: () => [] }), []);
  assert.deepEqual(
    backgroundActivity({ graphPhase: () => 'building', checkpointWarming: () => true, jobs: () => [job(process.pid), job(process.pid)] }),
    ['indexing code', 'checkpoint prep', '2 jobs'],
  );
  assert.deepEqual(backgroundActivity({ jobs: () => [job(process.pid)] }), ['1 job']);
});

test('a job whose process has gone is not counted as running', () => {
  // PID 2^31-1 is never a live process.
  assert.deepEqual(backgroundActivity({ jobs: () => [job(2147483647)] }), []);
});
