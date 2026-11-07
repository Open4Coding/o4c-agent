import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Tool } from './types.js';
import { walkFiles, globToRegExp } from './searchUtils.js';
import { groupGrepByDefinition, type Span } from './grepGroup.js';
import { languageForPath } from '../graph/languages.js';
import { extractFile } from '../graph/tags.js';
import { kindFromCapture } from '../graph/entityId.js';

/**
 * The definitions in each file that matched, parsed now with the bundled grammars - so the
 * grouping is right for the file as it is, index or no index. Only reached for a narrow search
 * (at most BROAD_FILES files), and a file with no grammar simply keeps its plain lines.
 */
async function spansOf(contents: Map<string, string>): Promise<Map<string, Span[]>> {
  const out = new Map<string, Span[]>();
  for (const [file, content] of contents) {
    const language = languageForPath(file);
    if (!language) continue;
    try {
      const { tags } = await extractFile(content, language.id);
      out.set(
        file,
        tags.filter((t) => t.kind === 'def' && t.endLine).map((t) => ({ name: t.name, kind: kindFromCapture(t.capture), line: t.line, endLine: t.endLine! })),
      );
    } catch {
      // no usable grammar: plain lines for this file
    }
  }
  return out;
}

const MAX_RESULTS = 200;
/**
 * A search this broad answers "where" before "what" (plan 0006 B13): per-file counts first, then
 * only the first lines. Two hundred raw lines from forty files cost thousands of tokens and still
 * stop partway; the counts tell the model where to narrow.
 */
const BROAD_FILES = 15;
const BROAD_MATCHES = 80;
const BROAD_LINES_SHOWN = 40;
const BROAD_FILES_SHOWN = 30;
/** Matches counted (not kept) before even the counting stops. */
const MAX_COUNTED = 5000;
/** A matching line longer than this is shown as the part around the match (ripgrep's --max-columns idea). */
export const MAX_LINE_CHARS = 300;
const CLIP_CONTEXT = 120;
/**
 * Files being read at once. One at a time, a whole-project search waits out every file open in
 * turn, and on Windows each first open of a file is also scanned by the antivirus: measured
 * 2026-11-07 on the VS Code source (21k files), 136 s for a search over files not read lately
 * against 15 s once they had been, and 7 m 42 s while the first index pass read the same files.
 */
const READ_AHEAD = 32;

/**
 * The line as shown in a result: whole when it is short, otherwise the match with `CLIP_CONTEXT`
 * characters either side and the full length said. Found 2026-11-06 on the VS Code source: one
 * hit was a 1.38 MB single-line test-data file, and the whole line went into the result.
 */
export function clipMatchLine(line: string, regex: RegExp): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const at = Math.max(0, line.search(regex));
  const matched = line.slice(at).match(regex)?.[0].length ?? 0;
  const start = Math.max(0, at - CLIP_CONTEXT);
  const end = Math.min(line.length, at + Math.min(matched, MAX_LINE_CHARS) + CLIP_CONTEXT);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''} [line is ${line.length.toLocaleString('en-US')} chars, clipped]`;
}

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
      const perFile = new Map<string, number>();
      const matchedContent = new Map<string, string>();
      let counted = 0;
      // Read ahead, matched in order: the results come out exactly as a one-at-a-time loop's would.
      const reads = new Array<Promise<string | undefined> | undefined>(files.length);
      const startRead = (i: number): void => {
        if (i < files.length) reads[i] = readFile(join(searchRoot, files[i]!), 'utf-8').catch(() => undefined);
      };
      for (let i = 0; i < READ_AHEAD; i++) startRead(i);
      outer: for (let f = 0; f < files.length; f++) {
        const file = files[f]!;
        const content = await reads[f];
        reads[f] = undefined;
        startRead(f + READ_AHEAD);
        if (content === undefined) continue;
        // A NUL in the first 8K is the usual test for a binary file (git uses the same one). Its
        // "lines" are noise at best and can be megabytes at worst; nothing in one is a search hit.
        if (content.slice(0, 8000).includes('\0')) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            if (results.length < MAX_RESULTS) results.push(`${file}:${i + 1}: ${clipMatchLine(lines[i].trim(), regex)}`);
            perFile.set(file, (perFile.get(file) ?? 0) + 1);
            if (perFile.size <= BROAD_FILES) matchedContent.set(file, content);
            if (++counted >= MAX_COUNTED) break outer;
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
      if (perFile.size > BROAD_FILES || counted > BROAD_MATCHES) {
        const capped = counted >= MAX_COUNTED ? ' (counting stopped there)' : '';
        const byCount = [...perFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const fileLines = byCount.slice(0, BROAD_FILES_SHOWN).map(([f, n]) => `  ${f} (${n})`);
        const moreFiles = byCount.length > BROAD_FILES_SHOWN ? [`  ... ${byCount.length - BROAD_FILES_SHOWN} more files`] : [];
        return [
          `${counted} matches in ${perFile.size} files${capped} - narrow with "path" or "glob" to see them all. Matches per file:`,
          ...fileLines,
          ...moreFiles,
          `First ${Math.min(BROAD_LINES_SHOWN, results.length)} matches:`,
          ...results.slice(0, BROAD_LINES_SHOWN),
        ].join('\n');
      }
      // Grouped under the definition each match is in (B13): the path once per file, and which
      // function a line belongs to - what the model would otherwise read the file to find out.
      const spans = await spansOf(matchedContent);
      return groupGrepByDefinition(results.join('\n'), (file) => spans.get(file));
    } catch (err) {
      return `Error searching "${pattern}" under "${baseDir}": ${(err as Error).message}`;
    }
  },
};
