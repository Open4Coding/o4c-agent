import type { Message } from '../providers/types.js';
import type { Line } from './types.js';
import { RESPONSE_TAG, RESULT_TAG, labelled, toolTag, userLine } from './labels.js';

/**
 * Formats a single raw message (role, content, tool calls, tool results) into display lines.
 * Used by /resume to repaint a loaded session's prior conversation into the scrollback - restoring
 * `AgentLoop`'s own memory via `loadMessages()` doesn't touch what's visible on screen.
 */
export function formatMessage(msg: Message): Line[] {
  const lines: Line[] = [];
  if (msg.role === 'user') {
    lines.push(userLine(msg.content));
    if (msg.images?.length) lines.push({ kind: 'system', text: `  (attached: ${msg.images.join(', ')})` });
  } else if (msg.role === 'assistant') {
    if (msg.content) lines.push({ kind: 'final', text: labelled(RESPONSE_TAG, msg.content) });
    for (const call of msg.toolCalls ?? []) {
      lines.push({
        kind: 'tool_call',
        text: labelled(toolTag(call.name), `${JSON.stringify(call.input)} id=${call.id}`),
      });
    }
  } else if (msg.role === 'tool') {
    // Trailing whitespace trimmed for the same reason as formatEvent.ts's truncate() - real tool
    // output very often ends in "\n", which would otherwise render as its own blank row on top
    // of App.tsx's separator row after every tool_call/tool_result line.
    lines.push({
      kind: 'tool_result',
      text: labelled(RESULT_TAG, `(id=${msg.toolCallId}) ${msg.content.replace(/\s+$/, '')}`),
    });
  }
  return lines;
}
