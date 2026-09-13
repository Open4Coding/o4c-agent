import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from './types.js';

const execAsync = promisify(exec);

export const runShellTool: Tool = {
  name: 'run_shell',
  description: 'Run a shell command and return its stdout/stderr output.',
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
        maxBuffer: 10 * 1024 * 1024,
      });
      return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return `Command failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    }
  },
};
