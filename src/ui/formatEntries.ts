import type { ContextEntry } from '../agent/contextEntry.js';
import type { AgentEvent } from '../agent/loop.js';
import { formatEvent } from './formatEvent.js';
import type { Line } from './types.js';

/** How many tool_call/tool_result events a turn shows before the rest collapse into one `[scan]`
 * summary line. Shared by the live display (App.tsx) and the /resume repaint below so a resumed
 * session looks like the one that was live. */
export const MAX_VISIBLE_TOOL_EVENTS_PER_TURN = 10;

/** How much of each kind of entry the repaint shows. Far more than the live display's 200-char
 * previews: the live view streamed all of it as it happened, and a reloaded screen that shows only
 * a sliver of the reasoning and narration reads as "the think and the response are gone". A
 * tool call's arguments are cut much shorter - a `write_file` call carries the whole file, which
 * is both noise on screen and a major cause of very tall frames. The full text always stays in the
 * session file and the run logs. */
export const THINK_PREVIEW_CHARS = 1500;
export const NARRATION_PREVIEW_CHARS = 4000;
export const TOOL_CALL_PREVIEW_CHARS = 300;

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function toolCallEvent(entry: ContextEntry): AgentEvent {
  try {
    const parsed = JSON.parse(entry.content) as { name?: string; input?: Record<string, unknown> };
    return { type: 'tool_call', toolName: parsed.name ?? '?', toolInput: parsed.input ?? {} };
  } catch {
    return { type: 'tool_call', toolName: '?', toolInput: {} };
  }
}

/**
 * Repaints a saved session's history from its full `ContextEntry` list, the way the live display
 * showed it - used by /resume. The old repaint went through the provider wire messages
 * (`toWireMessages` + `formatMessage`), which only contain what the model is sent: no `[think]`
 * blocks, every tool call/result shown in full, no `[scan]` collapse, a different line format.
 *
 * Per turn (a user input entry starts one): the user line, then in order any `[think]` block,
 * intermediate narration, and the first `MAX_VISIBLE_TOOL_EVENTS_PER_TURN` tool events as
 * `[tool]`/`[result]` lines (the rest collapse into one running `[scan]` summary, same wording as
 * live), then the turn's final answer. Entries a compaction replaced stay visible, matching the
 * `user_visible` rule in contextEntry.ts. `logHint` is what the `[scan]` line points at for the
 * full detail (the live display passes the run log's path; a resumed session has no such file).
 */
export function formatEntries(entries: readonly ContextEntry[], logHint = 'the run log'): Line[] {
  const lines: Line[] = [];
  let toolEvents = 0;
  let summary: Line | null = null;

  // A response is the turn's final answer only if no tool call follows it before the next user
  // input; otherwise it was intermediate narration between tool calls.
  const isFinalResponse = (index: number): boolean => {
    for (let j = index + 1; j < entries.length; j++) {
      const next = entries[j];
      if (next.type === 'user' && next.sub_type === 'input') return true;
      if (next.type === 'ai' && next.sub_type === 'toolcall') return false;
    }
    return true;
  };

  const pushToolLine = (event: AgentEvent): void => {
    toolEvents += 1;
    if (toolEvents <= MAX_VISIBLE_TOOL_EVENTS_PER_TURN) {
      const text =
        event.type === 'tool_call'
          ? `[tool] ${event.toolName}(${clip(JSON.stringify(event.toolInput ?? {}), TOOL_CALL_PREVIEW_CHARS)})`
          : formatEvent(event);
      if (text) lines.push({ kind: event.type === 'tool_call' ? 'tool_call' : 'tool_result', text });
      return;
    }
    const collapsed = toolEvents - MAX_VISIBLE_TOOL_EVENTS_PER_TURN;
    const text = `[scan] ${collapsed} more tool call${collapsed === 1 ? '' : 's'} collapsed - full detail in ${logHint}.`;
    if (summary) {
      summary.text = text;
    } else {
      summary = { kind: 'system', text };
      lines.push(summary);
    }
  };

  entries.forEach((entry, index) => {
    if (entry.user_visible === false) return;

    if (entry.type === 'user' && entry.sub_type === 'input') {
      toolEvents = 0;
      summary = null;
      lines.push({ kind: 'user', text: `> ${entry.content}` });
      if (entry.images?.length) lines.push({ kind: 'system', text: `  (attached: ${entry.images.join(', ')})` });
      return;
    }
    if (entry.type !== 'ai') return;

    switch (entry.sub_type) {
      case 'think': {
        if (entry.content) lines.push({ kind: 'system', text: `[think] ${clip(entry.content, THINK_PREVIEW_CHARS)}` });
        break;
      }
      case 'response': {
        if (!entry.content) break;
        if (isFinalResponse(index)) {
          lines.push({ kind: 'final', text: entry.content });
        } else {
          lines.push({ kind: 'system', text: clip(entry.content, NARRATION_PREVIEW_CHARS) });
        }
        break;
      }
      case 'toolcall':
        pushToolLine(toolCallEvent(entry));
        break;
      case 'toolcallresponse':
        pushToolLine({ type: 'tool_result', toolOutput: entry.content });
        break;
      case 'compaction':
        lines.push({ kind: 'system', text: '[compact] earlier history was summarized here' });
        break;
      case 'prune':
        lines.push({ kind: 'system', text: '[prune] older tool output was pruned here' });
        break;
      default:
        break;
    }
  });
  return lines;
}
