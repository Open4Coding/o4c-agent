import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveChildren, runShellCommand } from '../tools/shellRunner.js';
import { runShellTool } from '../tools/runShell.js';

/** Plan 0006 B20: a cancelled or timed-out command takes everything it started with it. */

const dir = mkdtempSync(join(tmpdir(), 'o4c-shell-'));
const spawner = join(dir, 'spawner.js');
// Starts a grandchild that would run forever, prints its pid, then keeps running itself.
writeFileSync(
  spawner,
  "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n" +
    "console.log('GRANDCHILD ' + c.pid);\n" +
    'setInterval(() => {}, 1000);\n',
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function grandchildAfter(stop: (signal: AbortController) => { timeoutMs: number }): Promise<{ pid: number; killed?: string }> {
  const controller = new AbortController();
  const { timeoutMs } = stop(controller);
  const r = await runShellCommand(`node "${spawner}"`, { timeoutMs, maxBufferBytes: 1_000_000, signal: controller.signal });
  const pid = Number(/GRANDCHILD (\d+)/.exec(r.stdout)?.[1]);
  assert.ok(pid > 0, `no grandchild pid in ${JSON.stringify(r.stdout)}`);
  return { pid, killed: r.killed };
}

test('Esc (abort): the grandchild is gone too', async () => {
  const { pid, killed } = await grandchildAfter((c) => {
    setTimeout(() => c.abort(), 1500);
    return { timeoutMs: 0 };
  });
  assert.equal(killed, 'aborted');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false, `grandchild ${pid} still running`);
  assert.equal(liveChildren(), 0);
});

test('timeout: the grandchild is gone too, and run_shell says what happened', async () => {
  const { pid, killed } = await grandchildAfter(() => ({ timeoutMs: 1500 }));
  assert.equal(killed, 'timeout');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false, `grandchild ${pid} still running`);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 800);
  const out = await runShellTool.execute({ command: `node "${spawner}"` }, { signal: controller.signal });
  assert.match(out, /^Command failed: cancelled by the user; the command and everything it started were stopped\./);
});

test('a command that leaves something running in the background still returns', async () => {
  // Exits on its own after 2 s, so the test leaves nothing behind on the machine.
  const sleeper = join(dir, 'sleeper.js');
  writeFileSync(sleeper, 'setTimeout(() => {}, 2000);\n');
  const started = Date.now();
  const bg = process.platform === 'win32' ? `start /b node "${sleeper}" & echo started` : `node "${sleeper}" > /dev/null & echo started`;
  const r = await runShellCommand(bg, { timeoutMs: 10_000, maxBufferBytes: 1_000_000 });
  assert.match(r.stdout, /started/);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

test('timeout_ms per call, and a configured default; 0 means no limit (B21)', async () => {
  const { setShellTimeoutDefault } = await import('../tools/runShell.js');
  const slow = 'node -e "setTimeout(() => console.log(\'finished\'), 1500)"';
  assert.match(await runShellTool.execute({ command: slow, timeout_ms: 300 }), /timed out after 0\.3 s.*pass a larger timeout_ms/);
  assert.match(await runShellTool.execute({ command: slow, timeout_ms: 0 }), /finished/);
  setShellTimeoutDefault(300);
  try {
    assert.match(await runShellTool.execute({ command: slow }), /timed out after 0\.3 s/);
  } finally {
    setShellTimeoutDefault(undefined);
  }
  assert.match(await runShellTool.execute({ command: slow }), /finished/);
});
