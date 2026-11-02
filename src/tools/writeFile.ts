import { writeFile as fsWriteFile, mkdir, access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { findPlaceholder } from './placeholders.js';
import { newSyntaxProblems, syntaxCheckMode } from './syntaxCheck.js';
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
  mutating: true,
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
      // "// ... rest unchanged" would replace the real code it stands for (plan 0006 B6).
      const before = existedBefore ? await readFile(path, 'utf-8') : '';
      const placeholder = findPlaceholder(content, before);
      if (placeholder) {
        return `Error writing file "${path}": the content contains "${placeholder}", which looks like a placeholder for code left out. write_file replaces the whole file, so that code would be lost. Nothing was written. Write the complete content, or use edit_file to change only part of the file.`;
      }
      // Checked before writing so strict mode can refuse; reported only if this write broke it (B8).
      const broken = await newSyntaxProblems(path, before, content);
      if (broken && syntaxCheckMode() === 'strict') {
        return `Error writing file "${path}": ${broken}. Nothing was written (syntax check is strict).`;
      }
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, 'utf-8');
      const verb = existedBefore ? 'Overwrote' : 'Wrote';
      return `${verb} ${content.length} characters to ${path}${broken ? `\nWarning: ${broken}. Fix it before going on.` : ''}`;
    } catch (err) {
      return `Error writing file "${path}": ${(err as Error).message}`;
    }
  },
};
