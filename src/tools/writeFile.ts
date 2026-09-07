import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from './types.js';

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
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, 'utf-8');
      return `Wrote ${content.length} characters to ${path}`;
    } catch (err) {
      return `Error writing file "${path}": ${(err as Error).message}`;
    }
  },
};
