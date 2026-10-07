import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from './types.js';

const execAsync = promisify(exec);

/**
 * How much output this tool will buffer at all. Was 10 MB, and that number is exactly what killed
 * two real runs on 2026-10-06: `dir /s /b D:\AngelCode` filled the whole 10 MB buffer, `exec`
 * rejected with "stdout maxBuffer length exceeded", and the catch path below then returned the full
 * 10 MB anyway - 11,370,857 chars, about 15x a 229,376-token window, in one tool result.
 *
 * `AgentLoop.boundToolOutput()` is the real bound on what reaches the model (see
 * `tools/toolOutput.ts`); this one keeps the huge string from being built, buffered and spilled in
 * the first place. 2 MB is far more than any result that can ever be shown, and small enough that a
 * runaway command fails fast instead of churning memory.
 */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/** Kept well under `MAX_BUFFER_BYTES` so a failure's own stdout/stderr tail can't reintroduce the
 * problem this module exists to avoid. The agent loop truncates again by window anyway; this just
 * means the oversized string is never assembled here. */
const MAX_FAILURE_OUTPUT_CHARS = 200_000;

function tail(text: string | undefined, label: string): string {
  if (!text) return '';
  if (text.length <= MAX_FAILURE_OUTPUT_CHARS) return text;
  const kept = text.slice(text.length - MAX_FAILURE_OUTPUT_CHARS);
  return `[${label} was ${text.length.toLocaleString()} chars; showing the last ${MAX_FAILURE_OUTPUT_CHARS.toLocaleString()}]\n${kept}`;
}

export const runShellTool: Tool = {
  name: 'run_shell',
  description:
    'Run a shell command and return its stdout/stderr output. Output is capped, so prefer commands that return only what you need - redirect a large listing to a file and read ranges of it instead.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
    },
    required: ['command'],
  },
  async execute(input) {
    const command = String(input.command ?? '');
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 60_000,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      // The "too much output" case needs to say so in a way the model can act on. Before this, the
      // explanation was the first line of an 11 MB payload, which is the same as not saying it.
      const overflowed = /maxBuffer length exceeded/i.test(e.message);
      const advice = overflowed
        ? '\nThis command produced more output than can be read. Narrow it (filter, count, or limit it), or redirect it to a file and read ranges with read_file.'
        : '';
      return `Command failed: ${e.message}${advice}\n${tail(e.stdout, 'stdout')}\n${tail(e.stderr, 'stderr')}`.trim();
    }
  },
};
