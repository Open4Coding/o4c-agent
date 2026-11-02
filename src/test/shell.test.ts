import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolveShell, shellPromptLine, setShell } from '../tools/shell.js';
import { runShellCommand } from '../tools/shellRunner.js';
import { runShellTool } from '../tools/runShell.js';

/** Plan 0006 B24: an explicit shell per OS, named in the system prompt, with live output. */

const hasPwsh = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { stdio: 'ignore' }).status === 0;

test('resolution: auto per OS, names, and paths', () => {
  assert.deepEqual(
    (({ kind, exe }) => ({ kind, exe }))(resolveShell('auto', 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })),
    { kind: 'cmd', exe: 'C:\\Windows\\system32\\cmd.exe' },
  );
  assert.equal(resolveShell(undefined, 'win32', {}).exe, 'cmd.exe');
  assert.equal(resolveShell('pwsh', 'win32').kind, 'pwsh');
  assert.equal(resolveShell('powershell', 'win32').exe, 'powershell.exe');
  assert.equal(resolveShell('C:\\Program Files\\Git\\bin\\bash.exe', 'win32').kind, 'bash');
  assert.ok(['bash', 'sh'].includes(resolveShell('auto', 'linux').kind));
  assert.equal(resolveShell('fish', 'win32').kind, 'cmd', 'an unknown shell falls back to auto');
  assert.deepEqual(resolveShell('bash', 'linux').argsFor('echo hi'), ['-c', 'echo hi']);
});

test('the prompt line fits the shell', () => {
  assert.match(shellPromptLine(resolveShell('cmd', 'win32'), 'win32'), /cmd\.exe .*not a Unix shell/);
  assert.match(shellPromptLine(resolveShell('pwsh', 'win32'), 'win32'), /PowerShell 7.*&& and \|\| work/);
  assert.match(shellPromptLine(resolveShell('powershell', 'win32'), 'win32'), /no && or \|\|/);
  assert.match(shellPromptLine(resolveShell('bash', 'linux'), 'linux'), /^Platform: Linux\. Shell commands run in bash/);
});

test('commands run in the chosen shell, and output arrives live', async () => {
  const seen: string[] = [];
  const r = await runShellCommand('node -e "console.log(1); setTimeout(() => console.log(2), 300)"', {
    timeoutMs: 10_000,
    maxBufferBytes: 1e6,
    onOutput: (t) => seen.push(t.trim()),
  });
  assert.equal(r.code, 0);
  assert.deepEqual(seen.filter(Boolean), ['1', '2'], 'two chunks, as they came');
  if (process.platform === 'win32') {
    const cmd = await runShellCommand('echo a& echo b', { timeoutMs: 10_000, maxBufferBytes: 1e6, shell: resolveShell('cmd') });
    assert.match(cmd.stdout, /a\s*\r?\nb/);
  }
});

test('pwsh, when installed, runs PowerShell syntax through run_shell', { skip: !hasPwsh }, async () => {
  setShell('pwsh');
  try {
    assert.equal(await runShellTool.execute({ command: 'Write-Output (6*7); $env:CI' }), '42\n1');
    assert.match(await runShellTool.execute({ command: 'exit 4' }), /^Command failed: exit code 4/);
  } finally {
    setShell(undefined);
  }
});
