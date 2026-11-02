import { readFile, writeFile } from 'node:fs/promises';
import { closestLines, findEdit, type MatchRung } from './editMatch.js';
import { findPlaceholder } from './placeholders.js';
import type { Tool } from './types.js';

const RUNG_TEXT: Record<MatchRung, string> = {
  exact: 'exactly',
  'line endings': 'ignoring line endings',
  'trailing whitespace': 'ignoring trailing whitespace',
  indentation: 'ignoring indentation - the new text was re-indented to fit',
  unescaped: 'after unescaping \\n and quotes in your text',
};

/** Lines of context around the changed region in the result, and the most lines it shows. */
const SNIPPET_CONTEXT = 2;
const SNIPPET_MAX_LINES = 30;

interface OneEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/**
 * The changed region of `after`, numbered, with a little context: everything between the first
 * and last line that differs from `before`. Lets the model check its edit without reading the file
 * again (plan 0006 B7). Long regions keep their start and end.
 */
export function changedRegion(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= top && tailB >= top && a[tailA] === b[tailB]) {
    tailA--;
    tailB--;
  }
  const from = Math.max(0, top - SNIPPET_CONTEXT);
  // Not the empty "line" after a final line break.
  const last = b.length > 1 && b[b.length - 1] === '' ? b.length - 2 : b.length - 1;
  const to = Math.min(last, Math.max(tailB, top) + SNIPPET_CONTEXT);
  const number = (i: number) => `${String(i + 1).padStart(5)}  ${b[i].replace(/\r$/, '')}`;
  const all = Array.from({ length: to - from + 1 }, (_, k) => from + k);
  if (all.length <= SNIPPET_MAX_LINES) return all.map(number).join('\n');
  const head = all.slice(0, SNIPPET_MAX_LINES - 10).map(number);
  const tail = all.slice(-10).map(number);
  return [...head, `       ... ${all.length - head.length - tail.length} more changed lines ...`, ...tail].join('\n');
}

/**
 * `edit_file` - change part of an existing file by search and replace.
 *
 * Added 2026-11-01 after the tmp4 long run: with only `write_file`, changing one line of a
 * 1,237-line parser meant re-emitting all 45K characters (brushing the output limit) or patching
 * it with `node -e` one-liners that Windows quoting kept breaking - the model spent whole turns
 * on scratch patch scripts instead of the fix. This is the edit every mainstream coding agent has.
 *
 * Text match on purpose, not a regex or a line number: line numbers drift as soon as an earlier
 * edit lands, and the model already holds the text it wants to change from reading the file.
 * Matching is exact first, then progressively more tolerant (editMatch.ts, plan 0006 B5), but on
 * every rung more than one match is refused unless `replace_all` is set, so an edit can never land
 * somewhere other than where the model meant.
 *
 * Several changes to one file go in one call as `edits` (B7): applied in order, each to the result
 * of the one before, and written only if every one of them applies - never half an edit.
 */
export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace exact text in an existing file. Use this for changes to a file instead of rewriting it with write_file. ' +
    '`old_string` must match the file exactly (whitespace included) and occur once - include enough surrounding lines ' +
    'to make it unique - or set `replace_all` to change every occurrence. For several changes to one file, pass ' +
    '`edits` instead: they apply in order, all or nothing. The result shows the changed lines.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
      old_string: { type: 'string', description: 'The exact text to replace.' },
      new_string: { type: 'string', description: 'The text to put in its place.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
      edits: {
        type: 'array',
        description: 'Several replacements instead of old_string/new_string: [{old_string, new_string, replace_all?}].',
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path'],
  },
  async execute(input) {
    const path = String(input.path ?? '');
    const fail = (why: string) => `Error editing file "${path}": ${why}`;
    const list: OneEdit[] = Array.isArray(input.edits)
      ? (input.edits as Array<Record<string, unknown>>).map((e) => ({
          oldString: String(e?.old_string ?? ''),
          newString: String(e?.new_string ?? ''),
          replaceAll: e?.replace_all === true,
        }))
      : input.old_string !== undefined || input.new_string !== undefined
        ? [{ oldString: String(input.old_string ?? ''), newString: String(input.new_string ?? ''), replaceAll: input.replace_all === true }]
        : [];
    if (list.length === 0) return fail('pass old_string and new_string, or a non-empty edits list.');

    let original: string;
    try {
      original = await readFile(path, 'utf-8');
    } catch (err) {
      return fail((err as Error).message);
    }

    let content = original;
    let replaced = 0;
    const notes: string[] = [];
    for (const [i, edit] of list.entries()) {
      // Which edit went wrong, when there are several - nothing has been written at this point.
      const which = list.length > 1 ? `edit ${i + 1} of ${list.length}: ` : '';
      const none = list.length > 1 ? ' None of the edits were applied.' : '';
      if (edit.oldString === '') return fail(`${which}old_string is empty - use write_file to create a file.${none}`);
      if (edit.oldString === edit.newString) return fail(`${which}old_string and new_string are the same.${none}`);
      // The ladder in editMatch.ts: exact first, then line endings, trailing whitespace, indentation
      // and over-escaping (B5) - each rung still refusing more than one match.
      const match = findEdit(content, edit.oldString, edit.newString);
      if (!match) {
        const near = closestLines(content, edit.oldString);
        return fail(
          `${which}old_string was not found, even ignoring line endings, trailing whitespace and indentation.${none} ` +
            (near ? `The closest lines in the file are:\n${near}\nCopy the exact text from there, or read the file again.` : 'Read the file again to copy the text exactly.'),
        );
      }
      // "// ... rest unchanged" in new_string would replace real code with the comment (plan 0006 B6).
      const placeholder = findPlaceholder(edit.newString, content);
      if (placeholder) {
        return fail(
          `${which}new_string contains "${placeholder}", which looks like a placeholder for code left out. new_string replaces old_string exactly, so that code would be lost. Nothing was changed. Write out the real code, or make old_string smaller so new_string does not need to repeat it.`,
        );
      }
      const count = match.ranges.length;
      const how = match.rung === 'exact' ? '' : ` (matched ${RUNG_TEXT[match.rung]})`;
      if (count > 1 && !edit.replaceAll) {
        return fail(`${which}old_string occurs ${count} times${how}. Include more surrounding text so it matches once, or set replace_all.${none}`);
      }
      // Spliced by offset rather than String.replace, so `$` sequences in new_string are taken literally.
      let next = '';
      let at = 0;
      for (const [start, end] of match.ranges) {
        next += content.slice(at, start) + match.replacement;
        at = end;
      }
      content = next + content.slice(at);
      replaced += count;
      if (match.rung !== 'exact') notes.push(`${list.length > 1 ? `edit ${i + 1} ` : ''}matched ${RUNG_TEXT[match.rung]}`);
    }

    try {
      await writeFile(path, content, 'utf-8');
    } catch (err) {
      return fail((err as Error).message);
    }
    const what = list.length > 1 ? `${list.length} edits, ${replaced} replacement${replaced === 1 ? '' : 's'}` : `replaced ${replaced} occurrence${replaced === 1 ? '' : 's'}`;
    return `Edited ${path}: ${what}${notes.length ? ` (${notes.join('; ')})` : ''}.\n${changedRegion(original, content)}`;
  },
};
