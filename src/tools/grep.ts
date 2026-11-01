import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Tool } from './types.js';
import { walkFiles, globToRegExp } from './searchUtils.js';

const MAX_RESULTS = 200;

export const grepTool: Tool = {
  name: 'grep_files',
  description:
    'Search file contents for a regular expression pattern. Returns matching lines as "path:line: content". ' +
    'Optionally restrict the search to files matching a glob pattern. ' +
    'Files excluded by .gitignore are not searched; use run_shell with grep to search those too.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Directory to search from, or a single file to search. Defaults to the current directory.' },
      glob: { type: 'string', description: 'Optional glob to restrict which files are searched, e.g. "*.ts".' },
    },
    required: ['pattern'],
  },
  async execute(input) {
    const pattern = String(input.pattern ?? '');
    const baseDir = String(input.path ?? '.');
    const glob = input.glob ? String(input.glob) : undefined;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return `Invalid regular expression "${pattern}": ${(err as Error).message}`;
    }

    try {
      // A single file is searched on its own. Until 2026-11-01 a file path went to the directory
      // walk, found no children and answered "No matches" - found on the tmp4 long run, where the
      // model concluded the tool was "unreliable" and fell back to findstr.
      const target = await stat(baseDir).catch(() => undefined);
      const singleFile = target?.isFile() === true;
      const searchRoot = singleFile ? dirname(baseDir) : baseDir;
      const walked = singleFile ? { entries: [], ignored: 0 } : await walkFiles(baseDir);
      let entries = walked.entries;
      if (glob) {
        const globRegex = globToRegExp(glob);
        entries = entries.filter((e) => globRegex.test(e.path));
      }
      const files = singleFile ? [basename(baseDir)] : entries.filter((e) => !e.isDirectory).map((e) => e.path);

      const results: string[] = [];
      outer: for (const file of files) {
        let content: string;
        try {
          content = await readFile(join(searchRoot, file), 'utf-8');
        } catch {
          continue;
        }
        // A NUL in the first 8K is the usual test for a binary file (git uses the same one). Its
        // "lines" are noise at best and can be megabytes at worst; nothing in one is a search hit.
        if (content.slice(0, 8000).includes('\0')) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
            if (results.length >= MAX_RESULTS) break outer;
          }
        }
      }

      if (results.length === 0) {
        // The one place the ignore count is worth its tokens. A model reads "no matches" as
        // "this does not exist anywhere", and that inference is wrong when the answer was in a
        // file `.gitignore` hid. On a search that *did* match, the same line would be noise on
        // every call, so it is not printed there.
        const unsearched =
          walked.ignored > 0
            ? ` ${walked.ignored} path(s) were not searched because .gitignore excludes them.`
            : '';
        return `No matches for "${pattern}" under "${baseDir}".${unsearched}`;
      }
      return results.join('\n') + (results.length >= MAX_RESULTS ? '\n... (results truncated)' : '');
    } catch (err) {
      return `Error searching "${pattern}" under "${baseDir}": ${(err as Error).message}`;
    }
  },
};
