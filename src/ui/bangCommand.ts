import type { Tool } from '../tools/types.js';

/**
 * `!command` (plan 0006 E7): the user runs a shell command themselves - no model call - through the
 * same run_shell machinery (environment, timeouts, the interactive-command refusal). The output is
 * shown at once and handed to the model at the start of the user's next message, as a block it can
 * tell apart from what the user typed.
 */
export function bangCommand(input: string): string | undefined {
  const m = /^!\s*(.+)$/s.exec(input.trim());
  return m ? m[1]!.trim() : undefined;
}

const MAX_NOTE_CHARS = 8000;

export async function runBang(command: string, shell: Tool): Promise<{ output: string; note: string }> {
  const output = await shell.execute({ command });
  const clipped = output.length > MAX_NOTE_CHARS ? `${output.slice(0, MAX_NOTE_CHARS)}\n... (cut at ${MAX_NOTE_CHARS.toLocaleString()} characters)` : output;
  return { output, note: `[The user ran this shell command themselves: ${command}]\n${clipped}` };
}

/** The next message with any pending `!` outputs in front of it. */
export function withShellNotes(notes: readonly string[], message: string): string {
  return notes.length ? `${notes.join('\n\n')}\n\n${message}` : message;
}
