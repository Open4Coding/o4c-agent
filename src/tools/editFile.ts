import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from './types.js';

/**
 * `edit_file` - change part of an existing file by exact search and replace.
 *
 * Added 2026-11-01 after the tmp4 long run: with only `write_file`, changing one line of a
 * 1,237-line parser meant re-emitting all 45K characters (brushing the output limit) or patching
 * it with `node -e` one-liners that Windows quoting kept breaking - the model spent whole turns
 * on scratch patch scripts instead of the fix. This is the edit every mainstream coding agent has.
 *
 * Exact match on purpose, not a regex or a line number: line numbers drift as soon as an earlier
 * edit lands, and the model already holds the text it wants to change from reading the file.
 * More than one match is refused unless `replace_all` is set, so an edit can never land somewhere
 * other than where the model meant.
 */
export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace exact text in an existing file. Use this for changes to a file instead of rewriting it with write_file. ' +
    '`old_string` must match the file exactly (whitespace included) and occur once - include enough surrounding lines ' +
    'to make it unique - or set `replace_all` to change every occurrence.',
  mutating: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file.' },
      old_string: { type: 'string', description: 'The exact text to replace.' },
      new_string: { type: 'string', description: 'The text to put in its place.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input) {
    const path = String(input.path ?? '');
    const oldString = String(input.old_string ?? '');
    const newString = String(input.new_string ?? '');
    const replaceAll = input.replace_all === true;
    if (oldString === '') return `Error editing file "${path}": old_string is empty - use write_file to create a file.`;
    if (oldString === newString) return `Error editing file "${path}": old_string and new_string are the same.`;

    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch (err) {
      return `Error editing file "${path}": ${(err as Error).message}`;
    }
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return `Error editing file "${path}": old_string was not found. It must match the file exactly, including whitespace and indentation - read the file again to copy it.`;
    }
    if (count > 1 && !replaceAll) {
      return `Error editing file "${path}": old_string occurs ${count} times. Include more surrounding text so it matches once, or set replace_all.`;
    }
    // split/join rather than String.replace, so `$` sequences in new_string are taken literally.
    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
    try {
      await writeFile(path, updated, 'utf-8');
    } catch (err) {
      return `Error editing file "${path}": ${(err as Error).message}`;
    }
    return `Edited ${path}: replaced ${count} occurrence${count === 1 ? '' : 's'}.`;
  },
};
