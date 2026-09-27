import { estimateTokens, type ContextEntry } from './contextEntry.js';

/**
 * §2.3's real compaction algorithm - trigger/cut-point mechanics adapted from Pi
 * (`research/agentic-frameworks/pi`'s `DEFAULT_COMPACTION_SETTINGS`: `reserveTokens: 16384`,
 * `keepRecentTokens: 20000`, confirmed directly against that source), the structured-summary
 * shape adapted from goose's `StructuredSummary`, and the cache-safety constraint from codex
 * ("no history rewrite" - compaction only ever *appends* a summary entry and flips visibility
 * flags on old ones, never rewrites or deletes anything already sent).
 */
export interface CompactionSettings {
  /** Token budget held back for the compaction call's own prompt/response - compaction triggers
   * once the visible context estimate gets within this many tokens of the model's real window. */
  reserveTokens: number;
  /** Roughly how many tokens' worth of the most recent entries stay verbatim, uncompacted - the
   * cut point is snapped to the nearest turn boundary at or after this budget is reached, so this
   * is a floor, not an exact count. */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Trigger: compact once the visible context estimate is within `reserveTokens` of the model's
 * real window. Pure and trivial on purpose - the real complexity is in `findCutPoint()`. */
export function shouldCompact(
  visibleTokenEstimate: number,
  contextWindow: number,
  reserveTokens: number = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
): boolean {
  return visibleTokenEstimate > contextWindow - reserveTokens;
}

function isTurnBoundary(entry: ContextEntry): boolean {
  return entry.type === 'user' && entry.sub_type === 'input';
}

/**
 * Finds the index to compact up to (exclusive) - entries `[0, cutPoint)` get folded into a
 * summary and hidden (`agent_visible = false`); entries `[cutPoint, end)` stay untouched.
 *
 * Walks backward from the end accumulating `estimateTokens()` for currently-visible entries
 * until `keepRecentTokens` is reached, then walks forward from there to the nearest turn boundary
 * (a `user`/`input` entry) - snapping to a turn boundary is what guarantees a `toolcall` is never
 * separated from its `toolcallresponse`, since neither can ever *be* a turn boundary itself, only
 * sit between two of them. Returns `0` (nothing to compact) if there's no earlier turn boundary to
 * cut at, or the log is too short to have one - compaction that can't find a safe cut point is a
 * no-op for this round, not a forced, unsafe one.
 */
export function findCutPoint(entries: readonly ContextEntry[], keepRecentTokens: number): number {
  let accumulated = 0;
  let candidate = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (accumulated >= keepRecentTokens) {
      candidate = i + 1;
      break;
    }
    const entry = entries[i];
    if (entry.agent_visible !== false) accumulated += estimateTokens(entry);
    candidate = i;
  }
  if (accumulated < keepRecentTokens) return 0; // whole log is smaller than the keep-budget

  for (let i = candidate; i < entries.length; i++) {
    if (isTurnBoundary(entries[i])) return i;
  }
  // No turn boundary at or after the candidate point (e.g. it landed inside the final, still-
  // open turn) - walk backward instead to the nearest boundary before it, so there's still a
  // safe (if slightly more conservative) cut rather than none at all.
  for (let i = candidate - 1; i >= 0; i--) {
    if (isTurnBoundary(entries[i])) return i;
  }
  return 0;
}

const SUMMARY_INSTRUCTIONS = `You are compacting an earlier portion of a coding-agent conversation to free up context space. Read the conversation content below and produce ONLY a single JSON object (no markdown fences, no commentary) with these fields, every one optional/omit if not applicable:

{
  "user_intent": "what the user is ultimately trying to accomplish",
  "technical_concepts": "key technologies, libraries, patterns involved",
  "files": [{"path": "...", "summary": "what changed or was learned about this file"}],
  "errors_and_fixes": "problems hit and how they were resolved",
  "problem_solving": "notable reasoning or approach decisions",
  "pending_tasks": "work mentioned but not yet done",
  "current_work": "what was actively in progress when this was cut",
  "next_step": "the very next thing to do"
}`;

/** One line per entry, readable enough for the summarizer model to work from - not the same as
 * §4's full-fidelity persisted row, just a plain-text projection for this one prompt. */
function serializeEntryForSummary(entry: ContextEntry): string {
  if (entry.type === 'user' && entry.sub_type === 'input') return `[User]: ${entry.content}`;
  if (entry.type === 'ai' && entry.sub_type === 'toolcall') {
    const parsed = JSON.parse(entry.content) as { name: string; input: unknown };
    return `[Tool call]: ${parsed.name}(${JSON.stringify(parsed.input)})`;
  }
  if (entry.type === 'ai' && entry.sub_type === 'toolcallresponse') return `[Tool result]: ${entry.content}`;
  if (entry.type === 'ai' && entry.sub_type === 'think') return `[Assistant reasoning]: ${entry.content}`;
  if (entry.type === 'ai' && entry.sub_type === 'compaction') return `[Earlier summary]: ${entry.content}`;
  if (entry.type === 'ai') return `[Assistant]: ${entry.content}`;
  return '';
}

/** Builds the one-shot prompt sent to the summarizer call. `previousSummary`, when given (this
 * isn't the session's first compaction), asks the model to *update* it rather than regenerate
 * from scratch - bounds the cost of repeated compactions over a long session (§2.3). */
export function buildCompactionPrompt(input: {
  entries: readonly ContextEntry[];
  previousSummary?: unknown;
}): string {
  const conversation = input.entries.map(serializeEntryForSummary).filter(Boolean).join('\n');
  if (input.previousSummary === undefined) {
    return `${SUMMARY_INSTRUCTIONS}\n\nConversation to summarize:\n\n${conversation}`;
  }
  return [
    SUMMARY_INSTRUCTIONS,
    '',
    'There is already a summary of everything before this point (as JSON). Update it with the new',
    'information below rather than starting over - move completed items into current/past fields,',
    'add new progress, drop anything that\'s no longer relevant.',
    '',
    '<previous-summary>',
    JSON.stringify(input.previousSummary),
    '</previous-summary>',
    '',
    'New conversation content to incorporate:',
    '',
    conversation,
  ].join('\n');
}

/** Lenient JSON parse of the summarizer's response - goose's own principle: a malformed or
 * partial response degrades to a plain-text summary rather than losing the compaction entirely
 * (the raw text is still far better than nothing for a model reading it back later). */
export function parseSummary(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return { current_work: trimmed };
  }
}
