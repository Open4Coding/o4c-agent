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

import type { McpToolProvenance } from '../tools/types.js';

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
export function previewLineCount(rows: number = currentSize().rows): number {
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

/**
 * What an MCP tool call's dialog says beyond the question itself.
 *
 * Three facts, in the order they matter to the decision:
 *
 * 1. **Whose tool this is.** The namespaced name already carries the server id, but spelled out
 *    under the question it is the difference between reading a prompt and decoding one.
 * 2. **Whether the call leaves the machine**, and where to. A local server and a remote one look
 *    identical in a tool name and are not remotely the same decision.
 * 3. **What the server claims about the tool**, reported as a claim. The spec is explicit that
 *    `ToolAnnotations` "should not be relied upon for security decisions" when they come from an
 *    untrusted server, so o4c shows them and says in the line itself that it does not act on them.
 *    Hiding them would be worse: they are often accurate, and the user is the one entitled to
 *    weigh that.
 *
 * `title` is deliberately left out - it is the server's display name for the tool, not a claim
 * about what the tool does, and `proxyTools` already folds it into the description the model sees.
 */
function mcpNotes(mcp: McpToolProvenance): string[] {
  const notes: string[] = [
    // Warning first on the remote line, for the same reason the claim line below leads with its
    // disclaimer. The first wording ended with "- this call leaves your machine" and lost exactly
    // that clause to clipping in an 80-column terminal, which is a normal terminal: the App-level
    // test caught it after the 100-column unit tests had all passed.
    mcp.reach === 'remote'
      ? `Leaves your machine - MCP server "${mcp.serverId}"${mcp.endpoint ? ` at ${mcp.endpoint}` : ''}.`
      : `Goes to MCP server "${mcp.serverId}", on this machine.`,
  ];

  const a = mcp.annotations;
  const claims: string[] = [];
  if (a?.readOnlyHint === true) claims.push('read-only');
  if (a?.readOnlyHint === false) claims.push('not read-only');
  if (a?.destructiveHint === true) claims.push('destructive');
  if (a?.destructiveHint === false) claims.push('non-destructive');
  if (a?.idempotentHint === true) claims.push('repeatable with no extra effect');
  if (a?.openWorldHint === true) claims.push('reaches outside this machine');
  if (claims.length > 0) {
    // Disclaimer first, claims second, and short enough to survive a narrow window - both of
    // those are the point rather than a preference.
    // The first version read "The server calls it X, Y - its own claim, which o4c does not
    // verify", and a probe of a tool with three annotations showed the line clipped at the
    // window's width mid-disclaimer: the screen then said the server "calls it read-only,
    // non-destructive" and nothing about who was claiming it. Clipping has to eat the least
    // important end of the line, so the end is where the claim list goes. The prefix was then
    // trimmed from "Server's own claim" to this after a probe at 40 columns (a 32-character
    // budget) cut the word "unverified" itself in half.
    notes.push(`Server's claim, unverified: ${claims.join(', ')}.`);
  }
  // Its own line rather than a clause on the one above: these lines are clipped to the window, and
  // the first version put this at the end of a sentence long enough to be cut off in an 80-column
  // terminal - losing exactly the part that explains why some of this server's tools stopped
  // asking at all.
  if (mcp.hintsTrusted) {
    notes.push("You have told o4c to believe this server's read-only claims.");
  }
  return notes;
}

export function formatConfirmMessage(
  toolName: string,
  input: Record<string, unknown>,
  size: PreviewSize = currentSize(),
  mcp?: McpToolProvenance,
  /**
   * `+3 -1` from `lineDiff.ts`, when the caller computed a diff for this write (item 8, design doc
   * §9.6). Its presence also means the diff rows themselves are about to be rendered beneath this
   * message, which changes what belongs in it - see the write_file branch.
   */
  diffSummary?: string,
  /**
   * The caller draws the new file's first lines itself, syntax-coloured (item 9), so the message
   * stops at the question and the notes.
   */
  previewDrawnSeparately = false,
): string {
  const budget = lineBudget(size.cols);
  // Under the question rather than above it: the first line is the one guaranteed to be on screen
  // in a window too short for the whole dialog, which is the failure this file was written to fix,
  // so the question keeps that line. Clipped like any other preview line for the same reason.
  const notes = mcp ? mcpNotes(mcp).map((note) => clipLine(note, budget)) : [];

  if (toolName === 'write_file' && typeof input.path === 'string' && typeof input.content === 'string') {
    const lines = input.content.split('\n');
    const head = `Allow write_file(${clipPathTail(input.path, Math.max(20, budget - 40))})? ${plural(input.content.length, 'character')}, ${plural(lines.length, 'line')}`;
    // With a diff about to be rendered, the content preview is **replaced**, not joined. Showing
    // both would roughly double the dialog's height for strictly less information - the diff's
    // changed lines are a subset of the content, and they are the part that answers the question -
    // and a dialog taller than the window is the exact failure this file was written to fix. The
    // counts stay, because "how big is this write" is a different question from "what changes".
    if (diffSummary) return [`${head}, ${diffSummary}`, ...notes].join('\n');
    if (previewDrawnSeparately) return [head, ...notes].join('\n');
    const shown = Math.min(lines.length, previewLineCount(size.rows));
    const preview = lines.slice(0, shown).map((l) => clipLine(l, budget));
    const hidden = lines.length - shown;
    return [
      head,
      ...notes,
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
      ...notes,
      ...shownLines,
      ...(truncated ? [clipLine(`... (command is ${plural(command.length, 'character')} in total)`, budget)] : []),
    ].join('\n');
  }

  const json = JSON.stringify(input);
  const shown = json.length > GENERIC_PREVIEW_CHARS ? `${json.slice(0, GENERIC_PREVIEW_CHARS)}...` : json;
  // The generic branch is the one every MCP tool lands in, since `write_file`/`run_shell` above
  // match built-in names only (a proxied tool is `mcp__<server>__...`), so this is where the notes
  // are actually read in practice.
  return [`Allow ${toolName}(${shown})?`, ...notes].join('\n');
}
