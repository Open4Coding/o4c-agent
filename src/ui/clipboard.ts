import { spawnSync } from 'node:child_process';
import type { Message } from '../providers/types.js';

/**
 * `/copy` (plan 0006 E9): a reply to the clipboard through the OS's own command - no native
 * dependency. Windows `clip` (fed UTF-16 with a byte-order mark so non-ASCII survives), macOS
 * `pbcopy`, Linux `wl-copy` / `xclip` / `xsel`. Over SSH none of those reach the user's machine,
 * so the OSC 52 escape is also written; terminals that support it put the text on the local
 * clipboard, the rest ignore it.
 */
export function replyBack(messages: readonly Message[], n = 1): string | undefined {
  const replies = messages.filter((m) => m.role === 'assistant' && m.content.trim() !== '');
  return replies[replies.length - n]?.content.trim();
}

type Runner = (cmd: string, args: string[], input: Buffer) => boolean;

const run: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, timeout: 5000 });
  return !r.error && r.status === 0;
};

export function clipboardCommands(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; utf16?: boolean }[] {
  if (platform === 'win32') return [{ cmd: 'clip', args: [], utf16: true }];
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  return [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

export function osc52(text: string): string {
  return `${String.fromCharCode(27)}]52;c;${Buffer.from(text, 'utf-8').toString('base64')}${String.fromCharCode(7)}`;
}

/** Copies `text`; says which way it went (`undefined` = no clipboard command worked). */
export function copyToClipboard(
  text: string,
  opts: { platform?: NodeJS.Platform; runner?: Runner; writeTerminal?: (s: string) => void } = {},
): string | undefined {
  const runner = opts.runner ?? run;
  let via: string | undefined;
  for (const c of clipboardCommands(opts.platform)) {
    const input = c.utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf-8');
    if (runner(c.cmd, c.args, input)) {
      via = c.cmd;
      break;
    }
  }
  const write = opts.writeTerminal ?? (process.stdout.isTTY ? (s: string) => process.stdout.write(s) : undefined);
  if (write && text.length <= 100_000) write(osc52(text));
  return via ?? (write ? 'the terminal (OSC 52)' : undefined);
}
