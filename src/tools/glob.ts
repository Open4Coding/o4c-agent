import type { Tool } from './types.js';
import { walkFiles, globToRegExp } from './searchUtils.js';

const MAX_RESULTS = 200;

export const globTool: Tool = {
  name: 'glob_files',
  description:
    'Find files and directories matching a glob pattern (directories are shown with a trailing /). ' +
    'Supports * (any chars except /), ** (recursive directories), and ? (a single char). Use pattern ' +
    '"*" to list the immediate contents of a directory. Returns matching paths relative to the given base directory.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts", "*.json", or "*" to list a directory.' },
      path: { type: 'string', description: 'Base directory to search from. Defaults to the current directory.' },
    },
    required: ['pattern'],
  },
  async execute(input) {
    const pattern = String(input.pattern ?? '');
    const baseDir = String(input.path ?? '.');
    try {
      const regex = globToRegExp(pattern);
      const entries = await walkFiles(baseDir);
      const matches = entries.filter((e) => regex.test(e.path));

      if (matches.length === 0) return `No files matched "${pattern}" under "${baseDir}".`;

      const truncated = matches.length > MAX_RESULTS;
      const shown = matches.slice(0, MAX_RESULTS).map((e) => (e.isDirectory ? `${e.path}/` : e.path));
      return (
        shown.join('\n') +
        (truncated ? `\n... (${matches.length - MAX_RESULTS} more results truncated)` : '')
      );
    } catch (err) {
      return `Error globbing "${pattern}" under "${baseDir}": ${(err as Error).message}`;
    }
  },
};
