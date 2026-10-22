import type { Tool } from './types.js';
import { walkFiles, globToRegExp } from './searchUtils.js';

const MAX_RESULTS = 200;

export const globTool: Tool = {
  name: 'glob_files',
  description:
    'Find files and directories matching a glob pattern (directories are shown with a trailing /). ' +
    'Supports * (any chars except /), ** (recursive directories), and ? (a single char). Use pattern ' +
    '"*" to list the immediate contents of a directory. Returns matching paths relative to the given base directory. ' +
    'Files excluded by .gitignore are not listed.',
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
      const walked = await walkFiles(baseDir);
      const matches = walked.entries.filter((e) => regex.test(e.path));

      if (matches.length === 0) {
        // Same reasoning as `grep_files`: an empty listing is the only point where the number of
        // paths `.gitignore` removed changes what the result means.
        const unsearched =
          walked.ignored > 0
            ? ` ${walked.ignored} path(s) are excluded by .gitignore.`
            : '';
        return `No files matched "${pattern}" under "${baseDir}".${unsearched}`;
      }

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
