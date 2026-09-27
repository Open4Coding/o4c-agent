import type { Line } from './types.js';

/**
 * One permanently-committed block of the terminal's scrollback - exactly what Ink's `<Static>`
 * renders once and never revisits. Static writes are append-only and irreversible (see
 * `resizeReflowFix.ts`'s header comment: remounting `<Static>` to "fix" it duplicates the entire
 * conversation, because Static has no concept of replacing what it already wrote) - `id` is only
 * ever assigned once, by `textWindowReducer`'s `commit` action, never reused or reassigned.
 */
export interface TextBlock {
  readonly id: number;
  readonly lines: readonly Line[];
}

/**
 * The data structure behind everything Ink actually draws for this app: `blocks` is the
 * permanent, append-only scrollback fed straight to `<Static items={blocks}>`; `live` is the
 * single in-flight region repainted every frame while a turn is running - replaced or cleared
 * wholesale, never something `<Static>` could own since Static can only ever grow. `nextId` is
 * this state's own counter (not a module-level mutable global, which is what `App.tsx` used
 * before this existed) - a fresh `initialTextWindow()` genuinely starts clean, and multiple
 * independent windows (e.g. in tests) never share or leak ids into each other.
 */
export interface TextWindowState {
  readonly blocks: readonly TextBlock[];
  readonly live: readonly string[];
  readonly nextId: number;
  /** Whether the last `live` line is an in-progress streamed-text line that the next
   * `appendDelta` should keep growing, rather than a distinct line (a tool call/result, the scan
   * summary, ...) that a delta should never be concatenated onto. Reset by everything else that
   * touches `live` - only `appendDelta` itself sets it true. */
  readonly deltaActive: boolean;
}

export type TextWindowAction =
  | { type: 'commit'; lines: Line[] }
  | { type: 'appendLive'; text: string }
  /** Raw streamed text chunks (`AgentEvent.type === 'delta'`) - appended onto the current live
   * line while a stream is in progress (`deltaActive`), or start a fresh line otherwise. This is
   * the one `live`-mutating action that doesn't mean "a new, distinct line" - see `deltaActive`. */
  | { type: 'appendDelta'; text: string }
  /** The `[scan] N more tool calls collapsed...` running summary line updates in place as the
   * count grows, rather than appending a new line per tool event once collapsing starts - the one
   * genuinely stateful (as opposed to append-only) update the live region needs. */
  | { type: 'updateScanSummary'; text: string }
  | { type: 'clearLive' }
  /** `/clear`/`/resume` replace the whole window wholesale with a fresh (or restored) block list -
   * distinct from `commit`, which only ever adds one block to what's already there. */
  | { type: 'reset'; blocks: TextBlock[] };

const SCAN_SUMMARY_PREFIX = '[scan] ';

/** `blocks` lets `/resume` seed a window that already has content (a restored session's
 * formatted history) - `nextId` picks up after the highest id already in use, so ids stay unique
 * even when starting from a non-empty list rather than always starting at 0. */
export function initialTextWindow(blocks: readonly TextBlock[] = []): TextWindowState {
  const nextId = blocks.reduce((max, b) => Math.max(max, b.id + 1), 0);
  return { blocks, live: [], nextId, deltaActive: false };
}

export function makeBlock(id: number, lines: Line[]): TextBlock {
  return { id, lines };
}

export function textWindowReducer(state: TextWindowState, action: TextWindowAction): TextWindowState {
  switch (action.type) {
    case 'commit': {
      if (action.lines.length === 0) return state;
      return {
        ...state,
        blocks: [...state.blocks, { id: state.nextId, lines: action.lines }],
        nextId: state.nextId + 1,
      };
    }
    case 'appendLive':
      return { ...state, live: [...state.live, action.text], deltaActive: false };
    case 'appendDelta': {
      if (state.live.length === 0 || !state.deltaActive) {
        return { ...state, live: [...state.live, action.text], deltaActive: true };
      }
      const live = state.live.slice();
      live[live.length - 1] += action.text;
      return { ...state, live, deltaActive: true };
    }
    case 'updateScanSummary':
      return {
        ...state,
        live: [...state.live.filter((l) => !l.startsWith(SCAN_SUMMARY_PREFIX)), action.text],
        deltaActive: false,
      };
    case 'clearLive':
      return state.live.length === 0 && !state.deltaActive ? state : { ...state, live: [], deltaActive: false };
    case 'reset':
      return initialTextWindow(action.blocks);
    default:
      return state;
  }
}
