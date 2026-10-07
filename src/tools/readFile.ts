import { readFile } from 'node:fs/promises';
import type { Tool } from './types.js';

/**
 * Lines returned when the caller doesn't ask for a range. Generous enough that ordinary source
 * files come back whole and byte-identical (the overwhelmingly common case), bounded so that
 * `read_file` on something like a 4.5 MB transcript can't try to put the whole thing in context.
 * Matches real Claude Code's own 2,000-line default for the same tool.
 *
 * This is a convenience bound, not the safety bound: `AgentLoop.boundToolOutput()` caps every tool
 * result by the model's actual window regardless (see `tools/toolOutput.ts`). Lines are the useful
 * unit here because a range is how a caller asks for the rest.
 */
const DEFAULT_LINE_LIMIT = 2_000;

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a text file at the given path. Returns up to 2000 lines at a time; use offset and limit to read a specific range of a longer file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
      offset: {
        type: 'number',
        description: 'Line number to start at, 1-indexed. Defaults to 1 (the start of the file).',
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to return. Defaults to ${DEFAULT_LINE_LIMIT}.`,
      },
    },
    required: ['path'],
  },
  async execute(input) {
    const path = String(input.path ?? '');
    const offset = positiveInt(input.offset) ?? 1;
    const limit = positiveInt(input.limit) ?? DEFAULT_LINE_LIMIT;
    try {
      const content = await readFile(path, 'utf-8');
      const lines = content.split('\n');
      // A trailing newline produces a final empty element; it is a line terminator, not a line, so
      // it must not count toward the total or be reported as a line of its own.
      const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
      const totalLines = hasTrailingNewline ? lines.length - 1 : lines.length;

      // The whole file, unasked-for range: return it exactly as it is on disk. No header, no
      // reassembly, nothing for a caller (or a test) to have to strip.
      if (offset === 1 && totalLines <= limit) return content;

      if (offset > totalLines) {
        return `read_file: "${path}" has ${totalLines.toLocaleString()} lines; offset ${offset.toLocaleString()} is past the end.`;
      }

      const start = offset - 1;
      const end = Math.min(start + limit, totalLines);
      const slice = lines.slice(start, end).join('\n');
      const header = `[read_file: lines ${offset.toLocaleString()}-${end.toLocaleString()} of ${totalLines.toLocaleString()} in "${path}". Use offset/limit to read another range.]`;
      return `${header}\n${slice}`;
    } catch (err) {
      return `Error reading file "${path}": ${(err as Error).message}`;
    }
  },
};
