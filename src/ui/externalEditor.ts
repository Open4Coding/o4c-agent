import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The user's own editor (plan 0006 E8, reused by /view-log, /edit-config and /debug): `$VISUAL`,
 * else `$EDITOR`, else Notepad on Windows and vi elsewhere. A terminal editor (vim, nano, ...)
 * takes over this terminal, so Ink's raw mode is released for its duration and restored after; a
 * GUI editor must block until closed (`code --wait`, not `code`).
 */
const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'micro', 'hx', 'helix', 'kak', 'joe', 'ne', 'mcedit', 'emacs']);

export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return (env.VISUAL || env.EDITOR || (platform === 'win32' ? 'notepad' : 'vi')).trim();
}

export function isTerminalEditor(command: string): boolean {
  const exe = command.split(/\s+/)[0]!.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
  if (exe === 'emacs') return /\s-nw\b|\s--no-window-system\b/.test(command) || !process.env.DISPLAY;
  return TERMINAL_EDITORS.has(exe);
}

/** Opens `path` in the editor and waits for it to close. Returns whether it ran. */
export function openInEditor(path: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; editor: string; error?: string } {
  const editor = editorCommand(env);
  const terminal = isTerminalEditor(editor);
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (on: boolean) => void; isRaw?: boolean };
  const wasRaw = !!stdin.isRaw;
  if (terminal && wasRaw) stdin.setRawMode?.(false);
  try {
    const r = spawnSync(`${editor} "${path}"`, { shell: true, stdio: terminal ? 'inherit' : 'ignore', windowsHide: false });
    if (r.error) return { ok: false, editor, error: r.error.message };
    if (r.status !== 0 && r.status !== null) return { ok: false, editor, error: `exited with ${r.status}` };
    return { ok: true, editor };
  } finally {
    if (terminal && wasRaw) stdin.setRawMode?.(true);
  }
}

/** Edits `text` in the editor; the edited text, or undefined when the editor could not run. */
export function editText(text: string, env: NodeJS.ProcessEnv = process.env): { text?: string; editor: string; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-compose-'));
  const file = join(dir, 'message.md');
  writeFileSync(file, text);
  try {
    const r = openInEditor(file, env);
    if (!r.ok) return { editor: r.editor, error: r.error };
    return { text: readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').replace(/\n+$/, ''), editor: r.editor };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
