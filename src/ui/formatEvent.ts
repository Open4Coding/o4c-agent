import type { AgentEvent } from '../agent/loop.js';

const PREVIEW_LENGTH = 200;

function truncate(text: string): string {
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
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
  if (event.type === 'tool_call') {
    return `[tool] ${event.toolName}(${JSON.stringify(event.toolInput)})`;
  }
  if (event.type === 'tool_result') {
    return `[result] ${truncate(event.toolOutput ?? '')}`;
  }
  return null;
}
