import type { AgentEvent } from '../agent/loop.js';

const PREVIEW_LENGTH = 200;

/** How much of a session a reload or `/resume` repaints, and - since 2026-10-09 - how much of a
 * live turn is shown as it happens. Declared here rather than imported from `formatEntries.ts`
 * because that module imports this one, and the dependency has to run one way. */
export type EventView = 'compact' | 'full';

/** Full view's one safety limit per line: a multi-megabyte tool result must not flood the
 * terminal even when the user has asked to see everything. */
export const FULL_ENTRY_CAP_CHARS = 200_000;

/** Full view's trim: everything, to that cap, with a pointer to where the rest lives. */
export function capFull(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length <= FULL_ENTRY_CAP_CHARS) return trimmed;
  const hidden = trimmed.length - FULL_ENTRY_CAP_CHARS;
  return `${trimmed.slice(0, FULL_ENTRY_CAP_CHARS)}
... (+${hidden.toLocaleString('en-US')} more characters, full text in the session file)`;
}

/** A tool call's arguments are cut to this many characters wherever they are displayed: a
 * `write_file` call carries the whole file, which is noise on screen and made committed blocks and
 * frames enormous. The full input stays in the session file and the run logs. */
export const TOOL_CALL_PREVIEW_CHARS = 300;

function truncate(text: string): string {
  // Trailing whitespace/newlines are extremely common in real tool output (shell stdout/stderr,
  // file reads almost always end in "\n") - left in, Ink renders that as its own blank row
  // *inside* this one Line's content, on top of the real blank-line separator App.tsx now adds
  // after every tool_call/tool_result line - a double gap the user actually saw on screen.
  // Trimmed once here, at the single place every branch below funnels through.
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > PREVIEW_LENGTH ? `${trimmed.slice(0, PREVIEW_LENGTH)}...` : trimmed;
}

/**
 * Formats an AgentEvent into a single display line, or null if it produces no output.
 *
 * In `compact` every branch is capped to a short preview, and the full untruncated content goes
 * to the run log (`RunLogger`, wired in `App.tsx`) instead, so a verbose model narrating file
 * contents inline, or a tool returning a large result, can't flood the terminal on its own.
 *
 * In `full` the line is shown whole, to `FULL_ENTRY_CAP_CHARS`. That is the same rule the repaint
 * (`formatEntries`) has always applied to a saved session, and until 2026-10-09 the live turn
 * ignored it entirely: `/set-sessionview full` produced a full repaint but a truncated live
 * screen, which is not what the setting says. Reported as "full means full, not compacted".
 */
export function formatEvent(event: AgentEvent, view: EventView = 'compact'): string | null {
  const full = view === 'full';
  const trim = (text: string): string => (full ? capFull(text) : truncate(text));
  if (event.type === 'text') {
    return event.text ? trim(event.text) : null;
  }
  if (event.type === 'think') {
    // Per direct instruction: `[think]` label, no closing marker - the line just ends, same as
    // every other bracketed-label line here (`[tool]`, `[result]`).
    return event.text ? `[think] ${trim(event.text)}` : null;
  }
  if (event.type === 'tool_call') {
    const json = JSON.stringify(event.toolInput ?? {});
    const shown =
      full || json.length <= TOOL_CALL_PREVIEW_CHARS ? capFull(json) : `${json.slice(0, TOOL_CALL_PREVIEW_CHARS)}...`;
    return `[tool] ${event.toolName}(${shown})`;
  }
  if (event.type === 'tool_result') {
    return `[result] ${trim(event.toolOutput ?? '')}`;
  }
  if (event.type === 'compaction') {
    return event.text ? `[compact] ${event.text}` : null;
  }
  if (event.type === 'prune') {
    return event.text ? `[prune] ${event.text}` : null;
  }
  if (event.type === 'warning') {
    return event.text ? `[warning] ${event.text}` : null;
  }
  if (event.type === 'delta') {
    // Raw, unprefixed, untruncated - callers that want the bracketed/truncated treatment other
    // event types get should special-case 'delta' before reaching this function (both App.tsx's
    // live region and cli.ts's printEvent do, since a delta is a streamed fragment of a line, not
    // a line of its own).
    return event.text || null;
  }
  return null;
}
