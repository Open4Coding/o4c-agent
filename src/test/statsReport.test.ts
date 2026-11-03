import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore } from '../session/usageStore.js';
import { formatDuration, formatStats, setTaskCountSource, taskCounts } from '../ui/statsReport.js';

const spend = (input: number, output: number) => () => ({ input, output, requests: 1, cached: 0, processed: 0, prefillMs: 0, draftN: 0, draftAccepted: 0 });

test('the machine total adds up across projects and processes, and is absent without a global file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-machine-'));
  try {
    const global = join(dir, 'usage-global.json');
    const a = new UsageStore(join(dir, 'p1', 'usage.json'), spend(100, 10), Date.now, global);
    a.load(undefined);
    a.setSessionId('s1');
    assert.deepEqual(a.totals().machine, { input: 100, output: 10 });
    a.flush();
    const b = new UsageStore(join(dir, 'p2', 'usage.json'), spend(50, 5), Date.now, global);
    b.load(undefined);
    assert.deepEqual(b.totals().machine, { input: 150, output: 15 });
    assert.deepEqual(b.totals().project, { input: 50, output: 5 });
    b.setSessionId('s2');
    b.flush();
    assert.deepEqual(JSON.parse(readFileSync(global, 'utf-8')), { input: 150, output: 15 });
    const plain = new UsageStore(join(dir, 'p3', 'usage.json'), spend(1, 1));
    plain.load(undefined);
    assert.equal(plain.totals().machine, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatDuration picks the two largest units', () => {
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(130_000), '2m 10s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

test('formatStats shows session, project, machine and tasks, and says when the project is not counted', () => {
  const session = { input: 1000, output: 200, requests: 4, activeMs: 100_000, cached: 750, processed: 250, prefillMs: 0, draftN: 0, draftAccepted: 0 };
  const lines = formatStats({ session, project: { input: 5000, output: 900 }, machine: { input: 9000, output: 1500 }, turns: 3, toolCalls: 7, tasks: { total: 5, done: 4, worked: 2 } }).join('\n');
  assert.match(lines, /Session: {2}1,000 prompt \/ 200 generated/);
  assert.match(lines, /4 requests, 3 of your messages, 7 tool calls/);
  assert.match(lines, /cache 75% of prompt tokens; active 1m 40s \(2 generated\/s/);
  assert.match(lines, /Machine: {2}9,000 prompt/);
  assert.match(lines, /Tasks: {4}5 in this project, 4 finished, 2 marked as worked/);
  assert.match(formatStats({ session, turns: 0, toolCalls: 0 }).join('\n'), /not counted/);
});

test('taskCounts reads the source, and survives a source that throws', () => {
  setTaskCountSource(() => ({ total: 1, done: 1, worked: 0 }));
  assert.deepEqual(taskCounts(), { total: 1, done: 1, worked: 0 });
  setTaskCountSource(() => {
    throw new Error('db closed');
  });
  assert.equal(taskCounts(), undefined);
  setTaskCountSource(undefined);
  assert.equal(taskCounts(), undefined);
});
