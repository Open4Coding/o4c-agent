import type { AgentEvent } from '../agent/loop.js';

const PREVIEW_LENGTH = 200;

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
 * Formats an AgentEvent into a single display line, or null if it produces no output. Every
 * branch is capped to a short preview - full untruncated content goes to the run log
 * (`RunLogger`, wired in `App.tsx`) instead, so a verbose model narrating file contents inline,
 * or a tool returning a large result, can't flood the terminal on its own.
 */
export function formatEvent(event: AgentEvent): string | null {
  if (event.type === 'text') {
    return event.text ? truncate(event.text) : null;
  }
  if (event.type === 'think') {
    // Per direct instruction: `[think]` label, no closing marker - the line just ends, same as
    // every other bracketed-label line here (`[tool]`, `[result]`).
    return event.text ? `[think] ${truncate(event.text)}` : null;
  }
  if (event.type === 'tool_call') {
    return `[tool] ${event.toolName}(${JSON.stringify(event.toolInput)})`;
  }
  if (event.type === 'tool_result') {
    return `[result] ${truncate(event.toolOutput ?? '')}`;
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
