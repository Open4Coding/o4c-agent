import { basename, extname } from 'node:path';
import type { AgentEvent } from '../agent/loop.js';
import { RESPONSE_TAG, RESULT_TAG, THINK_TAG, labelled, toolTag } from './labels.js';

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
    // The model talking to the user, whether it turns out to be the turn's answer or narration
    // between two tool calls - both are a response, and both get the label.
    return event.text ? labelled(RESPONSE_TAG, trim(event.text)) : null;
  }
  if (event.type === 'think') {
    return event.text ? labelled(THINK_TAG, trim(event.text)) : null;
  }
  if (event.type === 'tool_call') {
    // The name belongs to the label, the arguments to the content - so a call and its result line
    // up under tags of the same shape instead of the arguments wrapping around a `name(` prefix.
    return labelled(toolTag(event.toolName ?? '?'), toolCallText(event.toolName ?? '?', event.toolInput ?? {}, view));
  }
  if (event.type === 'tool_result') {
    return labelled(RESULT_TAG, trim(event.toolOutput ?? ''));
  }
  if (event.type === 'compaction') {
    return event.text ? labelled('[compact]', event.text) : null;
  }
  if (event.type === 'prune') {
    return event.text ? labelled('[prune]', event.text) : null;
  }
  if (event.type === 'warning') {
    return event.text ? labelled('[warning]', event.text) : null;
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

/** How many of a written file's lines the compact view shows under its path, and how wide each
 * may be - a minified file is one enormous line. */
export const WRITE_FILE_PREVIEW_LINES = 8;
export const WRITE_FILE_PREVIEW_LINE_CHARS = 120;

/**
 * The content half of a `[tool] <name>` line - item 42. Until 2026-10-31 every call was printed as
 * `JSON.stringify` of its arguments, so a `write_file` in the full view was the whole file as one
 * string with every newline and quote escaped, wrapped wherever the terminal edge fell.
 *
 * `write_file` now shows its path, then the file as real lines inside a fenced block, which
 * `LineText` colours exactly as it colours a code block in a reply (item 9). Every other tool -
 * built-in or MCP, whose arguments can have any shape - keeps the JSON. `id` is the pairing tag a
 * `/resume` repaint puts on calls and results; it goes on the first line.
 */
export function toolCallText(name: string, input: Record<string, unknown>, view: EventView, id?: string): string {
  const tag = id === undefined ? '' : ` id=${id}`;
  if (name === 'write_file' && typeof input.path === 'string' && typeof input.content === 'string') {
    return writeFileText(input.path, input.content, view, tag);
  }
  const json = JSON.stringify(input);
  if (view === 'full') return `${capFull(json)}${tag}`;
  return json.length <= TOOL_CALL_PREVIEW_CHARS ? `${json}${tag}` : `${json.slice(0, TOOL_CALL_PREVIEW_CHARS)}...${tag}`;
}

function writeFileText(path: string, content: string, view: EventView, tag: string): string {
  const all = content.replace(/\n$/, '').split('\n');
  const header = `${path} (${plural(all.length, 'line')}, ${plural(content.length, 'character')})${tag}`;

  let shown = all;
  let rest = 0;
  if (view === 'compact') {
    shown = all
      .slice(0, WRITE_FILE_PREVIEW_LINES)
      .map((line) => (line.length > WRITE_FILE_PREVIEW_LINE_CHARS ? `${line.slice(0, WRITE_FILE_PREVIEW_LINE_CHARS)}...` : line));
    rest = all.length - shown.length;
  } else if (content.length > FULL_ENTRY_CAP_CHARS) {
    // Full view's one safety limit, the same one every other line has (`capFull`), cut on a line
    // boundary so the block still closes.
    let used = 0;
    shown = [];
    for (const line of all) {
      if (used + line.length + 1 > FULL_ENTRY_CAP_CHARS) break;
      shown.push(line);
      used += line.length + 1;
    }
    rest = all.length - shown.length;
  }

  // The fence must be longer than any backtick run in the file, or a Markdown file being written
  // would close it early - the CommonMark rule, which `codeFences.ts` follows.
  // A loop, not `Math.max(...runs)`: a large file can have more runs than a call can take arguments.
  let longestRun = 0;
  for (const run of content.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const info = extname(path).slice(1) || basename(path);
  const more = rest > 0 ? [`... (+${plural(rest, 'more line')}, full text in the session file)`] : [];
  return [header, `${fence}${info}`, ...shown, fence, ...more].join('\n');
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}
