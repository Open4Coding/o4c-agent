import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Which shell `run_shell` uses, chosen explicitly (plan 0006 B24) rather than left to Node's
 * `shell: true` - so the system prompt can say exactly what the model is talking to, and the user
 * can pick another with `/set-shell` (config `shell`).
 *
 * `auto`: cmd.exe on Windows (what every earlier eval and run used); bash where it exists on Linux
 * and macOS, since models write bash and /bin/sh is often dash.
 */
export type ShellKind = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh';
export const SHELL_CHOICES: readonly string[] = ['auto', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'];
export const SHELL_CONFIG_KEY = 'shell';

export interface Shell {
  kind: ShellKind;
  exe: string;
  /** The argument list that runs `command`. */
  argsFor(command: string): string[];
  /** cmd.exe parses its own command line; Node must pass it through untouched. */
  verbatim: boolean;
}

function onPath(exe: string): boolean {
  const probe = process.platform === 'win32' ? spawnSync('where', [exe], { windowsHide: true, stdio: 'ignore' }) : spawnSync('which', [exe], { stdio: 'ignore' });
  return probe.status === 0;
}

function make(kind: ShellKind, exe: string): Shell {
  switch (kind) {
    case 'cmd':
      // What Node itself does for `shell: true` on Windows.
      return { kind, exe, argsFor: (c) => ['/d', '/s', '/c', `"${c}"`], verbatim: true };
    case 'powershell':
    case 'pwsh':
      return { kind, exe, argsFor: (c) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', c], verbatim: false };
    default:
      return { kind, exe, argsFor: (c) => ['-c', c], verbatim: false };
  }
}

function kindOf(exe: string): ShellKind | undefined {
  const name = basename(exe).toLowerCase().replace(/\.exe$/, '');
  return (['cmd', 'powershell', 'pwsh', 'bash', 'sh'] as const).find((k) => k === name);
}

/** The shell for a config value: a name from SHELL_CHOICES, or a path to one of those shells. */
export function resolveShell(setting: unknown, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Shell {
  const value = typeof setting === 'string' && setting.trim() ? setting.trim() : 'auto';
  const windows = platform === 'win32';
  if (value !== 'auto') {
    const kind = kindOf(value);
    if (kind) {
      const isPath = /[\\/]/.test(value);
      const exe = isPath ? value : kind === 'cmd' ? env.ComSpec || 'cmd.exe' : kind === 'powershell' ? 'powershell.exe' : kind;
      return make(kind, exe);
    }
  }
  if (windows) return make('cmd', env.ComSpec || 'cmd.exe');
  return existsSync('/bin/bash') || onPath('bash') ? make('bash', existsSync('/bin/bash') ? '/bin/bash' : 'bash') : make('sh', '/bin/sh');
}

let current: Shell | undefined;

export function setShell(setting: unknown): void {
  current = resolveShell(setting);
}

export function currentShell(): Shell {
  return (current ??= resolveShell(undefined));
}

/** The system prompt's line about the shell - what to write for the one actually in use. */
export function shellPromptLine(shell: Shell, platform: NodeJS.Platform = process.platform): string {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
  switch (shell.kind) {
    case 'cmd':
      return `Platform: ${os}. Shell commands run in cmd.exe (${shell.exe}), not a Unix shell: use Windows commands (dir, type, findstr, where, cd) and backslash paths. Do not assume Unix commands such as ls, cat, pwd, or grep exist.`;
    case 'pwsh':
      return `Platform: ${os}. Shell commands run in PowerShell 7 (pwsh): use PowerShell syntax (Get-ChildItem, Get-Content, Select-String, $env:NAME). && and || work; quote paths with spaces.`;
    case 'powershell':
      return `Platform: ${os}. Shell commands run in Windows PowerShell 5.1: use PowerShell syntax (Get-ChildItem, Get-Content, Select-String, $env:NAME). There is no && or ||: separate commands with ; and check $LASTEXITCODE.`;
    default:
      return `Platform: ${os}. Shell commands run in ${shell.kind} (${shell.exe}).`;
  }
}
