import type { Line } from './types.js';

/**
 * The one definition of how a labelled block looks on screen: the bracketed tag sits on its own
 * line and its content starts on the next one.
 *
 * Requested 2026-10-10. Until then a label was an inline prefix (`[think] the user is asking...`,
 * `> hello world`), so the first line of every block was indented by the width of its own label
 * and wrapped against a different left edge than the lines under it. Tag-above-content gives every
 * block the same left margin and makes the tags scannable down the screen.
 *
 * One `Line` carries both, not two - a line and its label are one unit everywhere they travel
 * (`lineSpacing.ts`'s gap rule, the live region's row maths, `<Static>`'s block list), and
 * splitting them would let a blank row be inserted between a tag and the text it names.
 */
export function labelled(tag: string, content: string): string {
  return content === '' ? tag : `${tag}\n${content}`;
}

/** Reasoning. */
export const THINK_TAG = '[think]';
/** Anything the model says to the user - the final answer and the narration between tool calls. */
export const RESPONSE_TAG = '[response]';
/** What the user typed, echoed into the transcript. Not the input box's own `>` prompt, which
 * marks where the cursor is rather than labelling a block. */
export const USER_TAG = '[user]';
/** A slash command's own output: `/set-sessionview`, `/config-*`, `/mode` and friends. Named so
 * the infinite-context store and later plugins have one tag to file this traffic under. */
export const INFO_TAG = '[info]';
/** A tool result. The matching call is `[tool] <name>` - the name stays on the label line, so a
 * call and its result read as a pair with the arguments and output below each. */
export const RESULT_TAG = '[result]';

/** `[tool] <name>`, the label half of a tool call. */
export function toolTag(name: string): string {
  return `[tool] ${name}`;
}

/** The transcript echo of what the user typed. Built here because `App.tsx` produces it in
 * fifteen places (every slash command plus the turn itself) and `formatEntries.ts` in a
 * sixteenth, and they have to stay identical or a repaint stops matching the live screen. */
export function userLine(input: string): Line {
  return { kind: 'user', text: labelled(USER_TAG, input) };
}

/** A slash command's reply. */
export function infoLine(text: string): Line {
  return { kind: 'system', text: labelled(INFO_TAG, text) };
}
