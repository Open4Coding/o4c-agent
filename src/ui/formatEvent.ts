import type { AgentEvent } from '../agent/loop.js';

/** Formats an AgentEvent into a single display line, or null if it produces no output. */
export function formatEvent(event: AgentEvent): string | null {
  if (event.type === 'text') {
    return event.text ? event.text : null;
  }
  if (event.type === 'tool_call') {
    return `[tool] ${event.toolName}(${JSON.stringify(event.toolInput)})`;
  }
  if (event.type === 'tool_result') {
    const output = event.toolOutput ?? '';
    const preview = output.slice(0, 200);
    return `[result] ${preview}${output.length > 200 ? '...' : ''}`;
  }
  return null;
}
