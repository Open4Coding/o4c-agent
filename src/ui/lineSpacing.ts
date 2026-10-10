import type { Line } from './types.js';

/** The bracketed labels that start a distinct block: the user's own message, reasoning, the
 * model's response, tool calls and results, a slash command's reply, the collapsed-tool summary,
 * and compaction/prune/warning notes. Each tag now sits on its own line above its content
 * (`labels.ts`), so this matches the tag line itself. */
const LABELLED = /^\s*\[(user|think|response|tool|result|info|scan|compact|prune|warning)\]/;

/**
 * Whether a blank row belongs between `prev` and `line` in a committed block: whenever EITHER of the
 * two is a labelled line (`[think]`, `[tool]`, ...). Without it a labelled line sat directly under
 * whatever came before it (the prompt, reasoning text) and the text after a `[think]` - the next
 * narration, or the final answer - was glued to it, so a block read as one dense wall. The one
 * exception is a line that follows a tool call/result: those already end with their own blank row
 * (App.tsx), and a second one would double the gap.
 */
export function needsGapBefore(prev: Line | undefined, line: Line): boolean {
  if (!prev) return false;
  if (prev.kind === 'tool_call' || prev.kind === 'tool_result') return false;
  // Already separated - a blank row is there because something else put it there (the live
  // commit path prepends one when a tag follows streamed text), and a second would double it.
  if (prev.text.trim() === '') return false;
  return LABELLED.test(line.text) || LABELLED.test(prev.text);
}

/** Whether this line opens a labelled block (`[think]`, `[tool] run_shell`, ...). Exported for
 * the commit path, which has to decide about a blank row before it has a `prev` line to compare
 * against - the previous block's last line lives in another block entirely. */
export function isLabelledLine(line: Line): boolean {
  return LABELLED.test(line.text);
}
