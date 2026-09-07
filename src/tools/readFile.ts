import { readFile } from 'node:fs/promises';
import type { Tool } from './types.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a text file at the given path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
    },
    required: ['path'],
  },
  async execute(input) {
    const path = String(input.path ?? '');
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      return `Error reading file "${path}": ${(err as Error).message}`;
    }
  },
};
