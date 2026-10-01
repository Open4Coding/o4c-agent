/**
 * The text of the yes/no approval dialog shown before a tool runs in Manual mode.
 *
 * It used to be `Allow <tool>(<the whole JSON input>)?`. For a `write_file` of a 13 KB file that is
 * about 77 rows: a frame taller than the window (206 rows in a 131-row window), repainted ~10 times a
 * second as 34 KB writes for as long as the dialog waited, with the tool name and path scrolled off
 * the top. Now: the question and the facts needed to judge it (what, where, how big) come first, then
 * a short preview - and the whole thing is sized from the terminal so it fits any window.
 *
 * The preview is display only. What actually runs/gets written is the unchanged tool input.
 */

export interface PreviewSize {
  cols: number;
  rows: number;
}

/** A `run_shell` command is the part worth reading in full before approving, so it gets a generous
 * cap - but not unbounded: a heredoc can embed a whole file. */
const MAX_COMMAND_CHARS = 600;
const MAX_COMMAND_LINES = 12;
const GENERIC_PREVIEW_CHARS = 400;

function currentSize(): PreviewSize {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

/** Width available for one preview line inside the bordered dialog (border + padding + margin). */
function lineBudget(cols: number): number {
  return Math.max(20, cols - 8);
}

/** How many file lines to preview: a quarter of the window, never fewer than 3 nor more than 8, so
 * the dialog stays a small part of any window. */
function previewLineCount(rows: number): number {
  return Math.max(3, Math.min(8, Math.floor(rows / 4)));
}

function clipLine(line: string, budget: number): string {
  const flat = line.replace(/\t/g, '  ').replace(/\r$/, '');
  return flat.length > budget ? `${flat.slice(0, budget - 3)}...` : flat;
}

/** Keeps the END of a long path (the file name is what matters) when the header would not fit. */
function clipPathTail(path: string, max: number): string {
  return path.length > max ? `...${path.slice(path.length - (max - 3))}` : path;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

export function formatConfirmMessage(
  toolName: string,
  input: Record<string, unknown>,
  size: PreviewSize = currentSize(),
): string {
  const budget = lineBudget(size.cols);

  if (toolName === 'write_file' && typeof input.path === 'string' && typeof input.content === 'string') {
    const lines = input.content.split('\n');
    const shown = Math.min(lines.length, previewLineCount(size.rows));
    const preview = lines.slice(0, shown).map((l) => clipLine(l, budget));
    const hidden = lines.length - shown;
    return [
      `Allow write_file(${clipPathTail(input.path, Math.max(20, budget - 40))})? ${plural(input.content.length, 'character')}, ${plural(lines.length, 'line')}`,
      ...preview,
      ...(hidden > 0 ? [clipLine(`... (+${plural(hidden, 'more line')})`, budget)] : []),
    ].join('\n');
  }

  if (toolName === 'run_shell' && typeof input.command === 'string') {
    const command = input.command;
    const cutByChars = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;
    const allLines = cutByChars.split('\n');
    const shownLines = allLines.slice(0, MAX_COMMAND_LINES).map((l) => clipLine(l, budget));
    const truncated = command.length > MAX_COMMAND_CHARS || allLines.length > MAX_COMMAND_LINES;
    return [
      'Allow run_shell?',
      ...shownLines,
      ...(truncated ? [clipLine(`... (command is ${plural(command.length, 'character')} in total)`, budget)] : []),
    ].join('\n');
  }

  const json = JSON.stringify(input);
  const shown = json.length > GENERIC_PREVIEW_CHARS ? `${json.slice(0, GENERIC_PREVIEW_CHARS)}...` : json;
  return `Allow ${toolName}(${shown})?`;
}
