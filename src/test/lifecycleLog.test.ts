import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LIFECYCLE_FILENAME,
  LIFECYCLE_MAX_BYTES,
  readLifecycle,
  recordLifecycle,
} from '../lifecycleLog.js';
import { RESTART_EXIT_CODE, runSupervisor } from '../restartHandoff.js';
import { findProjectRootSync } from '../session/projectContext.js';

/**
 * The lifecycle record, and the supervisor hook that feeds it.
 *
 * This file exists because of a specific failure: a `/set-sessionview` restart that locked up on
 * 2026-10-22 and could not be diagnosed, because the outgoing process wrote nothing on its way out
 * and the incoming one wrote nothing until the user typed. The questions these tests pin down are
 * exactly the ones that were unanswerable that night - did the next process start, what was it
 * asked to start with, and how far did it get.
 *
 * So the properties under test are mostly about *surviving*: a logger that throws during shutdown,
 * or that loses the last line, is worse than none, because it would make a restart look clean when
 * it was not.
 */

async function temp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'o4c-lifecycle-'));
}

test('a record round-trips, carrying its phase, pid and detail', async () => {
  const dir = await temp();
  try {
    recordLifecycle(dir, 'start', { argv: ['--mode', 'auto'], worker: true });
    const [record] = readLifecycle(dir);
    assert.equal(record.phase, 'start');
    assert.equal(record.pid, process.pid);
    assert.deepEqual(record.argv, ['--mode', 'auto']);
    assert.equal(record.worker, true);
    assert.ok(Date.parse(record.ts) > 0, 'a parseable timestamp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('phases accumulate in order, so the last one is where a process stopped', async () => {
  const dir = await temp();
  try {
    // The shape of a restart: one process runs to its handoff, the next starts and hangs before
    // the UI. Reading that off the file is the entire point of it existing.
    recordLifecycle(dir, 'start');
    recordLifecycle(dir, 'trusted', { trusted: true });
    recordLifecycle(dir, 'handoff', { args: ['--window', '50%'] });
    recordLifecycle(dir, 'exit', { code: RESTART_EXIT_CODE });
    recordLifecycle(dir, 'spawn', { args: ['--window', '50%'] });
    recordLifecycle(dir, 'start');
    recordLifecycle(dir, 'trusted', { trusted: true });

    const phases = readLifecycle(dir).map((r) => r.phase);
    assert.deepEqual(phases, ['start', 'trusted', 'handoff', 'exit', 'spawn', 'start', 'trusted']);
    // The diagnosis the real incident needed: a child was spawned, it started, and it never
    // reached 'render'. Without the file, 'spawn' and 'start' were both invisible.
    assert.ok(!phases.includes('render'), 'this session never painted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the directory is created on demand', async () => {
  const dir = await temp();
  try {
    const nested = join(dir, 'does', 'not', 'exist', 'yet');
    recordLifecycle(nested, 'start');
    assert.equal(readLifecycle(nested).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing is written, and nothing thrown, without a project to write to', () => {
  // A session with no trusted root has nowhere to put this, and creating a directory on its
  // behalf would be worse than staying quiet.
  assert.doesNotThrow(() => recordLifecycle(undefined, 'start'));
  assert.deepEqual(readLifecycle(undefined), []);
});

test('a logging failure never escapes into the caller', async () => {
  const dir = await temp();
  try {
    // A file where the directory should be: every fs call inside will fail. This runs from
    // `process.on('exit')` in the real app, where a throw would take out the shutdown path, so
    // swallowing is the required behaviour rather than mere politeness.
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'not a directory', 'utf-8');
    assert.doesNotThrow(() => recordLifecycle(blocked, 'exit', { code: 0 }));
    assert.deepEqual(readLifecycle(blocked), [], 'and reading it back is just as quiet');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn final line is skipped rather than losing the whole file', async () => {
  const dir = await temp();
  try {
    recordLifecycle(dir, 'start');
    recordLifecycle(dir, 'trusted');
    // What a process killed mid-append leaves behind - which is precisely the kind of process
    // this file is for, so it must not cost the records written before it.
    const path = join(dir, LIFECYCLE_FILENAME);
    const intact = await readFile(path, 'utf-8');
    await writeFile(path, `${intact}{"ts":"2026-01-01T00:00:0`, 'utf-8');

    const phases = readLifecycle(dir).map((r) => r.phase);
    assert.deepEqual(phases, ['start', 'trusted']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the file is trimmed to its recent half instead of growing forever', async () => {
  const dir = await temp();
  try {
    const path = join(dir, LIFECYCLE_FILENAME);
    const filler = `${JSON.stringify({ ts: 'x', pid: 1, phase: 'start', pad: 'y'.repeat(200) })}\n`;
    await writeFile(path, filler.repeat(Math.ceil(LIFECYCLE_MAX_BYTES / filler.length) + 50), 'utf-8');
    const before = readLifecycle(dir).length;

    recordLifecycle(dir, 'exit', { code: 0 });

    const after = readLifecycle(dir);
    assert.ok(after.length < before, `trimmed: ${after.length} < ${before}`);
    // The newest line is the one that matters, so it has to survive the trim that its own write
    // triggered.
    assert.equal(after[after.length - 1].phase, 'exit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- the supervisor hook

test('the supervisor reports every child it launches, with that child\'s arguments', async () => {
  const dir = await temp();
  try {
    const spawned: string[][] = [];
    let call = 0;
    const handoffPath = join(dir, 'handoff.json');

    const status = runSupervisor({
      nodePath: 'node',
      script: 'cli.js',
      initialArgs: ['--mode', 'manual'],
      handoffPath,
      env: {},
      onSpawn: (args) => recordLifecycle(dir, 'spawn', { args: [...args] }),
      spawn: (_command, args) => {
        spawned.push(args);
        call += 1;
        if (call === 1) {
          // The first child asks for a restart, exactly as /set-sessionview does.
          writeFileSync(handoffPath, JSON.stringify({ args: ['--mode', 'auto', '--window', '50%'] }), 'utf-8');
          return { status: RESTART_EXIT_CODE };
        }
        return { status: 0 };
      },
    });

    assert.equal(status, 0);
    assert.equal(spawned.length, 2, 'one restart means two children');

    const recorded = readLifecycle(dir).filter((r) => r.phase === 'spawn');
    assert.equal(recorded.length, 2, 'and both are on the record');
    assert.deepEqual(recorded[0].args, ['--mode', 'manual']);
    // The question the real incident could not answer: what was the replacement asked to run?
    assert.deepEqual(recorded[1].args, ['--mode', 'auto', '--window', '50%']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing hook cannot stop the app restarting', async () => {
  const dir = await temp();
  try {
    const handoffPath = join(dir, 'handoff.json');
    let call = 0;
    const status = runSupervisor({
      nodePath: 'node',
      script: 'cli.js',
      initialArgs: [],
      handoffPath,
      env: {},
      onSpawn: () => {
        throw new Error('disk full');
      },
      spawn: () => {
        call += 1;
        if (call === 1) {
          writeFileSync(handoffPath, JSON.stringify({ args: ['--mode', 'auto'] }), 'utf-8');
          return { status: RESTART_EXIT_CODE };
        }
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(call, 2, 'the restart still happened');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------- the synchronous root walk

test('the synchronous project root agrees with the rule the async one uses', async () => {
  const dir = await temp();
  try {
    assert.equal(findProjectRootSync(dir), undefined, 'no .o4c anywhere above');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.o4c'), { recursive: true });
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    // Found from a subdirectory, which is what matters: o4c is usually run from inside a package.
    assert.equal(findProjectRootSync(join(dir, 'src', 'deep')), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
