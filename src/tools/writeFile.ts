import { writeFile as fsWriteFile, mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from './types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write text content to a file, creating parent directories and overwriting the file if it exists.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
      content: { type: 'string', description: 'The full text content to write.' },
    },
    required: ['path', 'content'],
  },
  async execute(input) {
    const path = String(input.path ?? '');
    const content = String(input.content ?? '');
    try {
      const existedBefore = await fileExists(path);
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, 'utf-8');
      // No interactive confirmation yet (that's a real UI feature, tracked separately in
      // docs/frontend-design.checklist.md alongside run_shell's safety rails) - this at least
      // makes an overwrite visible in the transcript instead of silent.
      const verb = existedBefore ? 'Overwrote' : 'Wrote';
      return `${verb} ${content.length} characters to ${path}`;
    } catch (err) {
      return `Error writing file "${path}": ${(err as Error).message}`;
    }
  },
};
