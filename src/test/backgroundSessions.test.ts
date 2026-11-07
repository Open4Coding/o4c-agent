import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackgroundSessions } from '../session/backgroundSessions.js';
import { SessionStore } from '../session/sessionStore.js';
import { sessionsDirFor } from '../session/projectContext.js';

// Cleanup retries: on Windows a session process that has just finished can still hold its working
// directory for a moment, and the rm then fails with EPERM (seen once in CI, 2026-11-07).

/** Plan 0006 L1: background sessions - started detached, watched, stopped, opened when done. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function until(check: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for ' + what);
}

/** A stand-in for o4c: prints its arguments, then sleeps or exits as the task says. */
function fakeSelf(dir: string): { exe: string; args: string[] } {
  const script = join(dir, 'fake-o4c.cjs');
  writeFileSync(
    script,
    "const task = process.argv[process.argv.length - 1];\n" +
      "console.log('args: ' + process.argv.slice(2).join(' '));\n" +
      "if (task === 'sleep') setTimeout(() => {}, 60000); else process.exit(task === 'fail' ? 3 : 0);\n",
  );
  return { exe: process.execPath, args: [script] };
}

test('a background session runs on its own, reports finishing once, and shows its output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-bg-'));
  const bg = new BackgroundSessions(join(dir, 'sessions-bg'));
  try {
    const s = bg.start('write the docs', fakeSelf(dir), ['--provider', 'mock'], { cwd: dir, ownerPid: process.pid });
    assert.equal(s.n, 1);
    await until(() => bg.state(s).state === 'done', 'it to finish');
    assert.match(bg.tail(s), new RegExp(`args: --provider mock --session ${s.sessionId} write the docs`));
    assert.deepEqual(bg.takeFinished().map((x) => x.n), [1]);
    assert.deepEqual(bg.takeFinished(), [], 'reported once');
    assert.match(bg.describe(bg.get(1)!), /^#1 {2}done, \d+ min - write the docs$/);

    const failed = bg.start('fail', fakeSelf(dir), [], { cwd: dir, ownerPid: process.pid });
    assert.equal(failed.n, 2, 'numbered after the last');
    await until(() => bg.state(failed).state === 'failed', 'the failure');
    assert.equal(bg.state(failed).code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('a running background session can be stopped, and its owner stops the ones it started when it quits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-bg-stop-'));
  const bg = new BackgroundSessions(join(dir, 'sessions-bg'));
  try {
    const a = bg.start('sleep', fakeSelf(dir), [], { cwd: dir, ownerPid: process.pid });
    const b = bg.start('sleep', fakeSelf(dir), [], { cwd: dir, ownerPid: 999_999 });
    await until(() => bg.tail(a).includes('args:') && bg.tail(b).includes('args:'), 'both to start');
    assert.equal(bg.state(a).state, 'running');
    assert.ok(bg.stop(a));
    assert.equal(bg.state(a).state, 'stopped');
    assert.equal(bg.stop(a), false, 'already stopped');

    bg.stopOwned(999_999);
    assert.equal(bg.state(b).state, 'stopped', "the owner's exit hook stopped it");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('a real background o4c session saves into the project session store, so it can be opened here', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-bg-real-'));
  try {
    mkdirSync(join(dir, '.o4c'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const bg = new BackgroundSessions(join(dir, '.o4c', 'sessions-bg'));
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, O4C_LOCAL_API_KEY: '' };
    const s = bg.start('read a.txt', { exe: process.execPath, args: [TSX, CLI] }, ['--provider', 'mock'], { cwd: dir, ownerPid: process.pid, env });
    await until(() => bg.state(s).state !== 'running', 'the background o4c to finish', 90_000);
    assert.equal(bg.state(s).state, 'done', bg.tail(s));
    const saved = await new SessionStore(sessionsDirFor(dir)).load(s.sessionId);
    assert.ok(saved, 'the session is in the store /resume and /session open read');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
