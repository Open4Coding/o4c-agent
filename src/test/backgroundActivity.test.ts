import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundActivity, hms, indexDoneLine } from '../ui/backgroundActivity.js';
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

test('the index pass shows how far it has got once it has said', () => {
  assert.deepEqual(backgroundActivity({ graphPhase: () => 'building', graphProgress: () => ({ done: 1200, total: 11509 }) }), ['indexing code 1,200/11,509']);
  assert.deepEqual(backgroundActivity({ graphPhase: () => 'building', graphProgress: () => undefined }), ['indexing code']);
  assert.deepEqual(backgroundActivity({ graphPhase: () => 'ready', graphProgress: () => ({ done: 5, total: 5 }) }), []);
});

test('the end-of-pass line: files gone through and the time as hh:mm:ss, or why it failed', () => {
  const run = { indexed: 15000, unchanged: 902, removed: 0, outcomes: new Map(), failures: [], elapsedMs: 672_400 };
  assert.equal(indexDoneLine({ phase: 'ready', lastRun: run }), '[code graph] completed scan, scanned 15,902 files (00:11:12)');
  assert.equal(indexDoneLine({ phase: 'ready', lastRun: { ...run, indexed: 1, unchanged: 0 } }), '[code graph] completed scan, scanned 1 file (00:11:12)');
  assert.equal(indexDoneLine({ phase: 'failed', lastError: 'disk full' }), '[code graph] scan failed: disk full');
  assert.equal(hms(3_725_000), '01:02:05');
});
