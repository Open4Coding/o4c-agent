import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESTART_EXIT_CODE,
  buildRestartArgs,
  readHandoff,
  runSupervisor,
  writeHandoff,
  type SupervisorSpawn,
} from '../restartHandoff.js';

function tempHandoffPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-handoff-'));
  return { dir, path: join(dir, 'handoff.json') };
}

test('buildRestartArgs always carries model/provider/base-url and adds resume, mode and image only when set', () => {
  assert.deepEqual(buildRestartArgs({ model: 'm', provider: 'local', baseUrl: 'http://x' }), [
    '-m', 'm', '-p', 'local', '--base-url', 'http://x',
  ]);
  assert.deepEqual(
    buildRestartArgs({ model: 'm', provider: 'local', baseUrl: 'http://x', image: 'a.png', resumeId: 'abc', mode: 'auto' }),
    ['-m', 'm', '-p', 'local', '--base-url', 'http://x', '--image', 'a.png', '--resume', 'abc', '--mode', 'auto'],
  );
});

test('a handoff file round-trips and is deleted once read', () => {
  const { dir, path } = tempHandoffPath();
  try {
    writeHandoff(path, ['--resume', 'abc']);
    assert.deepEqual(readHandoff(path), ['--resume', 'abc']);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readHandoff rejects missing, malformed and wrongly-shaped files', () => {
  const { dir, path } = tempHandoffPath();
  try {
    assert.equal(readHandoff(path), undefined);
    writeFileSync(path, 'not json');
    assert.equal(readHandoff(path), undefined);
    writeFileSync(path, JSON.stringify({ args: ['ok', 3] }));
    assert.equal(readHandoff(path), undefined);
    writeFileSync(path, JSON.stringify({ nope: true }));
    assert.equal(readHandoff(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the supervisor relaunches on the restart exit code with the handed-off args and a fresh screen, then exits with the final code', () => {
  const { dir, path } = tempHandoffPath();
  try {
    const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawn: SupervisorSpawn = (_cmd, args, options) => {
      launches.push({ args, env: options.env });
      if (launches.length === 1) {
        writeHandoff(path, ['-m', 'm', '--resume', 'sess-1', '--mode', 'auto']);
        return { status: RESTART_EXIT_CODE };
      }
      if (launches.length === 2) {
        writeHandoff(path, ['-m', 'm', '--resume', 'sess-1', '--mode', 'auto']);
        return { status: RESTART_EXIT_CODE };
      }
      return { status: 0 };
    };
    const code = runSupervisor({ nodePath: 'node', script: 'cli.js', initialArgs: ['--foo'], handoffPath: path, env: {}, spawn });
    assert.equal(code, 0);
    assert.equal(launches.length, 3); // constant: one child at a time, however many restarts
    assert.deepEqual(launches[0].args, ['cli.js', '--foo']);
    assert.equal(launches[0].env.O4C_FRESH_SCREEN, undefined); // first launch keeps the screen
    assert.deepEqual(launches[1].args, ['cli.js', '-m', 'm', '--resume', 'sess-1', '--mode', 'auto']);
    assert.equal(launches[1].env.O4C_FRESH_SCREEN, '1');
    assert.equal(launches[2].env.O4C_FRESH_SCREEN, '1');
    for (const l of launches) {
      assert.equal(l.env.O4C_WORKER, '1');
      assert.equal(l.env.O4C_HANDOFF_FILE, path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the supervisor passes a normal exit code straight through and cleans up the handoff file', () => {
  const { dir, path } = tempHandoffPath();
  try {
    writeFileSync(path, 'stale');
    const code = runSupervisor({
      nodePath: 'node', script: 'cli.js', initialArgs: [], handoffPath: path, env: {}, spawn: () => ({ status: 3 }),
    });
    assert.equal(code, 3);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the supervisor stops instead of looping when a restart is requested without a valid handoff file', () => {
  const { dir, path } = tempHandoffPath();
  try {
    let calls = 0;
    const code = runSupervisor({
      nodePath: 'node', script: 'cli.js', initialArgs: [], handoffPath: path, env: {},
      spawn: () => {
        calls++;
        return { status: RESTART_EXIT_CODE };
      },
    });
    assert.equal(code, 1);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
