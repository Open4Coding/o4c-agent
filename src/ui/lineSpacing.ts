import type { Line } from './types.js';

/** The bracketed labels that start a distinct event line: reasoning, tool calls and results, the
 * collapsed-tool summary, compaction/prune notes and warnings. */
const LABELLED = /^\s*\[(think|tool|result|scan|compact|prune|warning)\]/;

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
  return LABELLED.test(line.text) || LABELLED.test(prev.text);
}
