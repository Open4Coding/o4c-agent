import type { Message } from '../providers/types.js';

/** Formats a single raw message (role, content, tool calls, tool results) into display lines. */
function formatMessage(msg: Message): string[] {
  const lines: string[] = [];
  if (msg.role === 'user') {
    lines.push(`[user] ${msg.content}`);
    if (msg.images?.length) lines.push(`  (attached: ${msg.images.join(', ')})`);
  } else if (msg.role === 'assistant') {
    if (msg.content) lines.push(`[assistant] ${msg.content}`);
    for (const call of msg.toolCalls ?? []) {
      lines.push(`  [call] ${call.name}(${JSON.stringify(call.input)}) id=${call.id}`);
    }
  } else if (msg.role === 'tool') {
    lines.push(`  [return] (id=${msg.toolCallId}) ${msg.content}`);
  }
  return lines;
}

/**
 * Formats the full raw conversation for the /debug view, capped to the most recent
 * `maxLines` lines with a truncation note - Ink's non-Static rendering repaints this
 * region rather than letting the terminal scroll it, so unbounded output wouldn't
 * actually be reachable past one screen height.
 */
export function formatDebugView(messages: readonly Message[], maxLines: number): string[] {
  const allLines = messages.flatMap(formatMessage);
  if (allLines.length <= maxLines) return allLines;
  const shown = allLines.slice(allLines.length - maxLines);
  return [`... (showing last ${maxLines} of ${allLines.length} lines) ...`, ...shown];
}
