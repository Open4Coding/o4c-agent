import type { ContextEntry } from '../agent/contextEntry.js';
import type { AgentEvent } from '../agent/loop.js';
import { TOOL_CALL_PREVIEW_CHARS, formatEvent } from './formatEvent.js';

export { TOOL_CALL_PREVIEW_CHARS };
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

/** How much of a saved session the screen shows: `compact` is the shortened view above; `full` shows
 * everything the session stored (the whole think, narration, tool arguments and results, and every
 * tool event with no `[scan]` collapse). Chosen with /set-sessionview. */
export type SessionView = 'compact' | 'full';

/** Anything that is not exactly `'full'` is `'compact'`, so a bad or missing config value falls back
 * to the original behaviour. */
export function parseSessionView(value: unknown): SessionView {
  return value === 'full' ? 'full' : 'compact';
}

// The cap and its trim now live in formatEvent.ts, so the live turn and this repaint apply one
// rule rather than two copies that drifted apart. Re-exported because callers (and tests) have
// always imported them from here.
import { capFull } from './formatEvent.js';
import { RESPONSE_TAG, RESULT_TAG, THINK_TAG, labelled, toolTag, userLine } from './labels.js';
export { FULL_ENTRY_CAP_CHARS, capFull } from './formatEvent.js';

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

/**
 * The one definition of what a `[think]` line looks like in a given view - whole (to the
 * per-entry cap) in `full`, clipped to a preview in `compact`.
 *
 * Shared by the repaint below and by App.tsx's live turn, which commits the same line to
 * scrollback as the turn ends. Keeping it in one place is the point: the two used to disagree,
 * because the live path committed nothing at all.
 */
export function thinkLineText(content: string, view: SessionView | undefined): string {
  return labelled(THINK_TAG, view === 'full' ? capFull(content) : clip(content, THINK_PREVIEW_CHARS));
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
export function formatEntries(
  entries: readonly ContextEntry[],
  logHint = 'the run log',
  options: { view?: SessionView } = {},
): Line[] {
  const full = options.view === 'full';
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
    if (full) {
      // Full view: every tool event, whole, no [scan] collapse.
      const text =
        event.type === 'tool_call'
          ? labelled(toolTag(event.toolName ?? '?'), capFull(JSON.stringify(event.toolInput ?? {})))
          : labelled(RESULT_TAG, capFull(event.toolOutput ?? ''));
      lines.push({ kind: event.type === 'tool_call' ? 'tool_call' : 'tool_result', text });
      return;
    }
    if (toolEvents <= MAX_VISIBLE_TOOL_EVENTS_PER_TURN) {
      const text = formatEvent(event);
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
      lines.push(userLine(entry.content));
      if (entry.images?.length) lines.push({ kind: 'system', text: `  (attached: ${entry.images.join(', ')})` });
      return;
    }
    if (entry.type !== 'ai') return;

    switch (entry.sub_type) {
      case 'think': {
        if (entry.content) {
          lines.push({ kind: 'system', text: thinkLineText(entry.content, options.view) });
        }
        break;
      }
      case 'response': {
        if (!entry.content) break;
        if (isFinalResponse(index)) {
          lines.push({ kind: 'final', text: labelled(RESPONSE_TAG, full ? capFull(entry.content) : entry.content) });
        } else {
          lines.push({
            kind: 'system',
            text: labelled(RESPONSE_TAG, full ? capFull(entry.content) : clip(entry.content, NARRATION_PREVIEW_CHARS)),
          });
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
