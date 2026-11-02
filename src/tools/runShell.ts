import type { Tool } from './types.js';
import { runShellCommand } from './shellRunner.js';
import { startJob } from './jobs.js';
import { interactiveReason, NON_INTERACTIVE_ENV } from './interactive.js';
import { childEnv } from '../session/redact.js';

const DEFAULT_TIMEOUT_MS = 60_000;
let defaultTimeoutMs = DEFAULT_TIMEOUT_MS;

/** Config `shellTimeoutMs` (B21): the timeout when a call gives none; 0 or negative = none. */
export function setShellTimeoutDefault(ms: unknown): void {
  defaultTimeoutMs = typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFAULT_TIMEOUT_MS;
}

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
      timeout_ms: { type: 'number', description: 'Kill it after this many ms (default 60000; 0 = no limit, for long builds).' },
      background: { type: 'boolean', description: 'Start it in the background (a server, a watcher) and return at once; read it later with job_output.' },
    },
    required: ['command'],
  },
  async execute(input, context) {
    const command = String(input.command ?? '');
    // Editors, pagers, REPLs: refused with what to do instead, rather than a timeout (B23).
    const interactive = interactiveReason(command);
    if (interactive) return `Command not run: ${interactive}`;
    // Without o4c's own keys (C4), and never prompting (B23).
    const env = { ...childEnv(), ...NON_INTERACTIVE_ENV };
    if (input.background === true) {
      // B22: detached, outlives the per-turn reload; see jobs.ts.
      try {
        const job = startJob(command, process.cwd(), env);
        return `Started background job ${job.id}: ${command}\nIt keeps running after this call. Read its output with job_output (id "${job.id}"); you will be told when it finishes.`;
      } catch (err) {
        return `Command failed: could not start it in the background: ${(err as Error).message}`;
      }
    }
    const timeoutMs = typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms) ? input.timeout_ms : defaultTimeoutMs;
    // spawn + whole-tree kill on Esc or timeout (B20) - see shellRunner.ts.
    const raw = await runShellCommand(command, { timeoutMs, maxBufferBytes: MAX_BUFFER_BYTES, signal: context?.signal, env, onOutput: context?.onOutput });
    // LF only: cmd and PowerShell write CRLF, which costs tokens and trips exact comparisons.
    const r = { ...raw, stdout: raw.stdout.replace(/\r\n/g, '\n'), stderr: raw.stderr.replace(/\r\n/g, '\n') };
    if (!r.killed && r.code === 0) return [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)';

    let why: string;
    if (r.killed === 'overflow') {
      // The "too much output" case needs to say so in a way the model can act on. Before this, the
      // explanation was the first line of an 11 MB payload, which is the same as not saying it.
      why = `stdout maxBuffer length exceeded (${MAX_BUFFER_BYTES.toLocaleString()} bytes); the command and everything it started were stopped.\nThis command produced more output than can be read. Narrow it (filter, count, or limit it), or redirect it to a file and read ranges with read_file.`;
    } else if (r.killed === 'timeout') {
      why = `timed out after ${timeoutMs / 1000} s; the command and everything it started were stopped. If it needs longer, pass a larger timeout_ms (0 = no limit).`;
    } else if (r.killed === 'aborted') {
      why = 'cancelled by the user; the command and everything it started were stopped.';
    } else {
      why = `exit code ${r.code}: ${command}`;
    }
    return `Command failed: ${why}\n${tail(r.stdout, 'stdout')}\n${tail(r.stderr, 'stderr')}`.trim();
  },
};
