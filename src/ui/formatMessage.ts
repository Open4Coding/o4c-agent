import type { Message } from '../providers/types.js';
import type { Line } from './types.js';

/**
 * Formats a single raw message (role, content, tool calls, tool results) into display lines.
 * Used by /resume to repaint a loaded session's prior conversation into the scrollback - restoring
 * `AgentLoop`'s own memory via `loadMessages()` doesn't touch what's visible on screen.
 */
export function formatMessage(msg: Message): Line[] {
  const lines: Line[] = [];
  if (msg.role === 'user') {
    lines.push({ kind: 'user', text: `[user] ${msg.content}` });
    if (msg.images?.length) lines.push({ kind: 'system', text: `  (attached: ${msg.images.join(', ')})` });
  } else if (msg.role === 'assistant') {
    if (msg.content) lines.push({ kind: 'final', text: `[assistant] ${msg.content}` });
    for (const call of msg.toolCalls ?? []) {
      lines.push({ kind: 'tool_call', text: `  [call] ${call.name}(${JSON.stringify(call.input)}) id=${call.id}` });
    }
  } else if (msg.role === 'tool') {
    lines.push({ kind: 'tool_result', text: `  [return] (id=${msg.toolCallId}) ${msg.content}` });
  }
  return lines;
}
