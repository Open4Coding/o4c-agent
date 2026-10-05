import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../providers/types.js';
import { ServerUnavailableError } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

const INITIAL_TOKEN_RATIO = 1.5;
const MIN_TOKEN_RATIO = 0.5;
const MAX_TOKEN_RATIO = 3;

const CUTOFF_CONTINUE_PROMPT ='Continue exactly where you stopped. Do not repeat anything already written.';
import {
  aiCompactionEntry,
  aiPruneEntry,
  aiResponseEntry,
  systemNoticeEntry,
  aiThinkEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  estimateTextTokens,
  estimateTokens,
  splitThinkBlock,
  toWireMessages,
  userInputEntry,
  type ContextEntry,
} from './contextEntry.js';
import {
  buildCompactionPrompt,
  findCutPoint,
  microCompactCutoffIndex,
  parseSummary,
  shouldCompact,
  compactionSettingsForWindow,
  DEFAULT_MICRO_COMPACT_RESERVE_TOKENS,
  type CompactionSettings,
} from './compaction.js';
import { createThinkTagStripper } from './streamFilter.js';

export interface AgentEvent {
  type: 'text' | 'think' | 'tool_call' | 'tool_result' | 'compaction' | 'prune' | 'delta' | 'warning';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  /** `'think'`/`'text'` only - whether this call's content already streamed live via 'delta'
   * events. A provider that doesn't implement `onToken` (optional on `LLMProvider`, e.g. a test
   * fake, or a real provider that hasn't added streaming yet) still needs its content to reach the
   * user somehow - consumers should only skip re-displaying 'think'/'text' when this is `true`;
   * otherwise this event is the *only* place that content ever shows up. */
  streamed?: boolean;
  /** `'delta'` only - whether this streamed chunk is reasoning ("think") or the final answer
   * ("text"), straight from the provider's own per-chunk signal (see `providers/types.ts`'s
   * `onToken` doc comment) via `createThinkTagStripper`. Lets the live UI label reasoning the
   * instant it starts streaming, not just after the fact. */
  kind?: 'think' | 'text';
}

export interface RunOptions {
  /** Caps how many provider round-trips a single `run()` call can make before giving up with
   * `MaxIterationsError`. Undefined (unset) falls back to 25. 0 or negative means "no cap at all"
   * - the same "0/negative disables it" convention `LocalProvider`'s connect/idle timeouts already
   * use (see local.ts's own doc comment) - for long, unattended tool-call chains (e.g. a local
   * model doing extended autonomous research/work) where 25 is nowhere near enough and there's no
   * natural cap to pick instead. Not actually unbounded in practice: `checkAborted()` still runs
   * every iteration and before every tool call, so Escape/Ctrl+C still stops it immediately, and
   * every provider/tool call already has its own independent timeout backstop (LocalProvider's
   * connect/idle timeouts, run_shell's own cap) - this only removes the *iteration-count* ceiling,
   * nothing else that could otherwise leave the process stuck. */
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
  images?: string[];
  /** Called before executing each tool call - lets the caller (App.tsx, via the mode system in
   * src/ui/modePolicy.ts) allow or deny it. Omitted entirely, every tool call runs unconditionally
   * (existing callers/tests keep working exactly as before). */
  toolPolicy?: (tool: Tool, input: Record<string, unknown>) => Promise<'allow' | 'deny'>;
  /** Called once per `ContextEntry` the instant it's appended during this `run()` call - §7's
   * infinite-context plugin (not built yet) is the intended subscriber, persisting the exact
   * object it's handed with no translation step (§5.1). Omitted entirely, entries are still
   * created and used to build requests as normal; there's just no listener (a no-op), matching
   * `toolPolicy`'s own optional-callback convention below. */
  onEntry?: (entry: ContextEntry) => void;
  /** Called once per completed provider round-trip - the main turn loop's own call and §2.3's
   * compaction summarization call alike - with the exact request sent and exact response
   * received, before any local post-processing (splitThinkBlock, etc.). The raw wire-level
   * transcript, for a full-context log distinct from the already-derived AgentEvent stream -
   * intended future consumer is the same infinite-context/compression work `onEntry` above is
   * for. Never called for a failed/aborted request. Omitted entirely, nothing extra happens. */
  onProviderCall?: (call: { request: CompletionRequest; response: CompletionResponse }) => void;
  /** Appended (with a blank-line separator) to the system prompt for this request only - lets the
   * caller (App.tsx, via `modePolicy.ts`'s `modeSystemPrompt()`) tell the model what its current
   * mode actually allows, so it behaves accordingly instead of only discovering a restriction
   * reactively via `toolPolicy` denying a call it already attempted. Per-request rather than baked
   * into the constructor's fixed `systemPrompt`, since the mode can change mid-session without
   * restarting `AgentLoop`. Omitted entirely, the system prompt is sent unchanged (existing
   * callers/tests keep working exactly as before). */
  modeInstruction?: string;
  /** Lets the caller cancel this turn before the provider responds (e.g. the user pressed
   * Escape while the "Thinking..." spinner was showing). On abort, `run()` throws
   * `AbortedError` and rolls back everything this call appended to history, as if the turn had
   * never been sent. */
  signal?: AbortSignal;
  /** The active model's real max context size, in tokens - §2.3's real compaction (§2.3, see
   * `compaction.ts`) only ever runs when this is known, same "never guess" principle as the
   * status bar/`/context` display (both read the same opt-in `contextWindow` config key).
   * Omitted, compaction never triggers - existing callers/tests keep working exactly as before. */
  contextWindow?: number;
  /** Overrides `DEFAULT_COMPACTION_SETTINGS` - almost never needed, exposed mainly for tests to
   * exercise compaction without building enormous fixture logs. */
  compactionSettings?: CompactionSettings;
}

/** Thrown when the loop exhausts its iteration budget without the model reaching a final answer. */
export class MaxIterationsError extends Error {
  constructor(public readonly maxIterations: number) {
    super(`stopped after ${maxIterations} iterations without a final answer`);
    this.name = 'MaxIterationsError';
  }
}

/** Thrown when `options.signal` is aborted mid-turn. Carries the original prompt back so the
 * caller (App.tsx) can restore it into the input box unchanged - conversation history for this
 * turn is rolled back in `run()` before this is thrown, as if the turn had never been sent. */
export class AbortedError extends Error {
  constructor(public readonly prompt: string) {
    super('turn cancelled by the user');
    this.name = 'AbortedError';
  }
}

export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  /** Number of completion requests actually sent to the provider, not turns or tool calls. */
  requestCount: number;
}

export class AgentLoop {
  private entries: ContextEntry[] = [];
  /** id -> entry, kept in lockstep with `entries` (see `indexEntry()`/`deindexEntry()`) - O(1)
   * lookup for `tool_call_id` linkage, `is_correct` marking, and (once §2.3 compaction exists)
   * flipping `agent_visible` on the entries a summary replaces, instead of an O(n) array scan. */
  private entriesById = new Map<string, ContextEntry>();
  /** Running estimate of `entries` with `agent_visible !== false`, i.e. what `toWireMessages()`
   * would currently send - §2.3's eventual compaction trigger reads this. Maintained incrementally
   * (indexEntry/deindexEntry) so checking it every turn is O(1), not a rescan of the whole log. */
  private visibleTokenEstimate = 0;
  private usage: CumulativeUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  /** The real, API-reported prompt-token count from the most recent request, and what
   * `visibleTokenEstimate` was at that exact moment - together let `hybridPromptTokenEstimate()`
   * report `realCount + estimatedDelta` instead of re-estimating the whole history from scratch
   * every time (chars/4 is rough; anchoring on a real count and only estimating what's new since
   * bounds the error to just the newest content). Verified directly against real Claude Code's own
   * `tokenCountWithEstimation()` (`src/utils/tokens.ts`) - same technique, confirmed via source
   * read, not guessed - and Codex's `get_total_token_usage()`, both doing the same thing
   * independently. `undefined` until the first real response of the process's lifetime. */
  private lastRealPromptTokens: number | undefined;
  private visibleEstimateAtLastRealCount = 0;
  /** Real prompt tokens per plain chars/4 estimate, measured from the last real response. Measured live
   * against the local server: prose ~0.76, code-heavy ~1.9. */
  private tokenRatio = INITIAL_TOKEN_RATIO;

  constructor(
    private provider: LLMProvider,
    private tools: Tool[],
    private systemPrompt: string,
  ) {}

  private indexEntry(entry: ContextEntry): void {
    this.entriesById.set(entry.id, entry);
    if (entry.agent_visible !== false) {
      this.visibleTokenEstimate += estimateTokens(entry);
    }
  }

  private deindexEntry(entry: ContextEntry): void {
    this.entriesById.delete(entry.id);
    if (entry.agent_visible !== false) {
      this.visibleTokenEstimate -= estimateTokens(entry);
    }
  }

  /** Stores a UI-only note in history: saved with the session, never sent to the model or counted toward its context. */
  addNotice(content: string): void {
    this.appendEntry(systemNoticeEntry(content), () => {});
  }

  /** Clears conversation history and cumulative usage, starting a fresh session on the next `run()`. */
  reset(): void {
    this.entries = [];
    this.entriesById.clear();
    this.visibleTokenEstimate = 0;
    this.usage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  /** Conversation history projected to the provider wire format - see `toWireMessages()` in
   * `contextEntry.ts` (§5.1) for exactly how a response's own text/tool-call entries get
   * regrouped back into one assistant message. For anything needing the richer, untranslated
   * fields (timestamps, tags, tool-call linkage, etc.), use `getEntries()` instead. */
  getMessages(): readonly Message[] {
    return toWireMessages(this.entries);
  }

  /** Raw entry log so far - every user input, AI response, tool call, and tool result, in the
   * full `ContextEntry` shape (§5.1/§7.3), not just the wire-format projection. For debug/
   * inspection UIs and anything that needs more than `getMessages()`'s projection provides. */
  getEntries(): readonly ContextEntry[] {
    return this.entries;
  }

  /** Token usage accumulated across every provider request this session, as reported by the provider - not estimated (except MockProvider, which has no real tokenizer to ask). */
  getUsage(): Readonly<CumulativeUsage> {
    return this.usage;
  }

  /** Estimated token size of exactly what `getMessages()`/`toWireMessages()` would send right now
   * (`agent_visible !== false` entries only) - the number §2.3's compaction trigger compares
   * against a model's `contextWindow`. O(1) - see `visibleTokenEstimate`. */
  getVisibleTokenEstimate(): number {
    return this.visibleTokenEstimate;
  }

  /**
   * Replaces in-memory history with a previously-saved session's entries (for /resume).
   * Cumulative usage resets to zero - it tracks this process's own request activity, not a
   * lifetime total for the session, so there's nothing real to restore it to.
   */
  loadEntries(entries: readonly ContextEntry[]): void {
    this.entries = [...entries];
    this.entriesById = new Map();
    this.visibleTokenEstimate = 0;
    for (const entry of this.entries) this.indexEntry(entry);
    this.usage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  private appendEntry(entry: ContextEntry, onEntry: (entry: ContextEntry) => void): void {
    this.entries.push(entry);
    this.indexEntry(entry);
    onEntry(entry);
  }

  /** Truncates `entries` back to `length`, undoing `indexEntry()`'s bookkeeping for everything
   * removed - the rollback path both abort branches in `run()` use, kept in one place so the map/
   * token-estimate invariant can't drift out of sync with a bare `entries.length = n` at a second
   * call site. */
  private rollbackTo(length: number): void {
    for (const entry of this.entries.splice(length)) {
      this.deindexEntry(entry);
    }
  }

  /**
   * Frees the heavy payload of an entry the instant compaction/MicroCompact hides it from the
   * agent. Hidden entries are dropped from `toWireMessages()` (nothing ever resends them), the
   * UI already displayed them at append time, and the untruncated record already exists on disk
   * (run log + full-context log), so their in-memory bytes are pure dead weight for the rest of
   * the process's life - the unbounded accumulator behind the long-session RSS climb: compaction
   * hid them from the *model* but never from the *heap* (a pruned 10 MB tool output stayed
   * resident until the process died). Only already-hidden entries are touched here; a
   * still-visible entry must keep its full content because it may be resent this very turn.
   * The signature/redacted-thinking replay data goes with it - replay only ever reads visible
   * think entries (see `toWireMessages()`'s own `agent_visible` skip). Session persistence is
   * the one consumer that sees the placeholder, by design: the session file is the working
   * /resume state, not the record (that's the run/full-context logs' job), and a resumed
   * process re-indexes the placeholder at its (tiny) new size with nothing to lose - the entry
   * stays `agent_visible=false`, so it stays out of the wire either way.
   */
  private releaseEntryContent(entry: ContextEntry): void {
    if (entry.content.length <= 256) return;
    entry.content = `[${entry.sub_type} content released from memory after compaction]`;
    entry.thinking_signature = undefined;
    entry.redacted_thinking = undefined;
    entry.images = undefined;
  }

  /**
   * Real gap found via direct probe (`tmp.tmp/probe-compaction.ts` scenario E): the compaction
   * trigger only ever read `visibleTokenEstimate` (entry content alone) - but every real request
   * this turn sends also carries the system prompt (plus any `modeInstruction`) and every tool's
   * full JSON schema, identical on every single call, none of which was in the estimate. The
   * trigger therefore fired later than the true request size, eating into `reserveTokens`' own
   * margin - the one thing it exists to protect. Computed fresh on every check rather than cached:
   * `tools` never changes after construction, but `modeInstruction` is per-request and can differ
   * turn to turn.
   */
  private overheadTokenEstimate(modeInstruction?: string): number {
    const systemPromptForRequest = modeInstruction ? `${this.systemPrompt}\n\n${modeInstruction}` : this.systemPrompt;
    const toolDefsJson = JSON.stringify(
      this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    );
    return estimateTextTokens(systemPromptForRequest) + estimateTextTokens(toolDefsJson);
  }

  /** Real bug found via direct reproduction (2026-10-02): a pure chars/4 estimate was off by just
   * enough (57346 vs a 57344 hard limit - 2 tokens) to let a request through that the server then
   * rejected outright. Anchors on the last real `usage.inputTokens` (when we have one) and adds
   * only the estimated delta since then, instead of re-estimating the whole visible history from
   * scratch - see the `lastRealPromptTokens` field's own doc comment for where this technique is
   * verified from. Falls back to the plain estimate (history + overhead) before the first real
   * response of the process's lifetime. */
  private hybridPromptTokenEstimate(modeInstruction?: string): number {
    if (this.lastRealPromptTokens !== undefined) {
      const delta = this.visibleTokenEstimate - this.visibleEstimateAtLastRealCount;
      // Only growth is scaled up, and never below 1x: a shrink (compaction) stays at chars/4, which keeps the estimate high.
      return this.lastRealPromptTokens + Math.ceil(delta > 0 ? Math.max(1, this.tokenRatio) * delta : delta);
    }
    return Math.ceil(this.tokenRatio * (this.visibleTokenEstimate + this.overheadTokenEstimate(modeInstruction)));
  }

  /**
   * §2.3's MicroCompact tier (2026-09-28) - tier 2 of 3, cheaper than `maybeCompact()`'s real
   * summarization call (tier 3) and run before it. No API call at all: old `toolcall`/
   * `toolcallresponse` pairs (matched by `tool_call_id`, not assumed adjacent) get flipped
   * `agent_visible=false` in place, exactly like `maybeCompact()`'s own entries - append-and-flip,
   * never rewrite (codex's constraint, same reasoning as tier 3). One `prune`-typed marker entry
   * is appended per pass, however many pairs it found this round - not one per pair, which would
   * just be noise for what's otherwise a routine, frequent, free operation.
   *
   * Synchronous (no `await`) - there's no provider call to make, which is the entire point of this
   * tier existing. Skips entirely once nothing new is left to prune (either the log is still
   * smaller than `keepRecentTokens`, or every old pair in range was already hidden by an earlier
   * pass) - a marker entry that pruned nothing would be actively misleading.
   */
  private maybeMicroCompact(
    contextWindow: number,
    settings: CompactionSettings,
    onEvent: (event: AgentEvent) => void,
    onEntry: (entry: ContextEntry) => void,
    modeInstruction?: string,
  ): void {
    const microCompactReserve = settings.microCompactReserveTokens ?? DEFAULT_MICRO_COMPACT_RESERVE_TOKENS;
    // Hybrid real+delta estimate (see hybridPromptTokenEstimate's own doc comment) - falls back to
    // the exact same plain estimate this line used to compute directly when there's no real usage
    // yet, so this is a no-op for any scenario without one (every existing test, until now).
    const effectiveVisible = this.hybridPromptTokenEstimate(modeInstruction);
    if (!shouldCompact(effectiveVisible, contextWindow, microCompactReserve)) return;

    const cutoff = microCompactCutoffIndex(this.entries, settings.keepRecentTokens);
    if (cutoff === 0) return; // whole log is still under the keep-recent budget - nothing old enough yet

    // Matched by id rather than assumed adjacent (unlike loop.ts's own append order, which is
    // always back-to-back) - correct regardless of what ends up between them, e.g. an earlier
    // compaction/prune marker. Index tracked alongside the entry, not just the entry itself -
    // `microCompactCutoffIndex` doesn't snap to a turn boundary the way `findCutPoint` does, so
    // the cutoff can land exactly between a pair; both entries must be strictly before it, or a
    // response `microCompactCutoffIndex` meant to keep in the verbatim recent tail could get
    // hidden anyway just because its call happened to fall on the old side of the cutoff.
    const responsesByCallId = new Map<string, { entry: ContextEntry; index: number }>();
    this.entries.forEach((entry, index) => {
      if (entry.type === 'ai' && entry.sub_type === 'toolcallresponse' && entry.tool_call_id) {
        responsesByCallId.set(entry.tool_call_id, { entry, index });
      }
    });

    let prunedPairCount = 0;
    let tokensFreed = 0;
    for (let i = 0; i < cutoff; i++) {
      const call = this.entries[i];
      if (call.type !== 'ai' || call.sub_type !== 'toolcall' || call.agent_visible === false || !call.tool_call_id) {
        continue;
      }
      const found = responsesByCallId.get(call.tool_call_id);
      if (!found || found.index >= cutoff || found.entry.agent_visible === false) continue;
      const response = found.entry;

      tokensFreed += estimateTokens(call) + estimateTokens(response);
      this.deindexEntry(call);
      call.agent_visible = false;
      this.indexEntry(call);
      this.deindexEntry(response);
      response.agent_visible = false;
      this.indexEntry(response);
      this.releaseEntryContent(call);
      this.releaseEntryContent(response);
      prunedPairCount += 1;
    }
    if (prunedPairCount === 0) return;

    // Appended at the end, not spliced - unlike a full compaction's single contiguous block, the
    // pairs this hid are scattered among still-visible entries (user turns, responses, an earlier
    // summary), so there's no one position that reads as "where they used to be." The end is also
    // exactly where this pass happened chronologically - nothing after it exists yet.
    const pruneEntry = aiPruneEntry(prunedPairCount, tokensFreed, `older tool call${prunedPairCount === 1 ? '' : 's'}`);
    this.entries.push(pruneEntry);
    this.indexEntry(pruneEntry);
    onEntry(pruneEntry);
    onEvent({
      type: 'prune',
      text: `Pruned ${prunedPairCount} older tool call${prunedPairCount === 1 ? '' : 's'} (~${tokensFreed} tokens freed).`,
    });
  }

  /**
   * §2.3's real compaction pass - checked once at the top of `run()`, before the new turn's own
   * user message is appended. Best-effort: any failure (provider error, abort) is caught and
   * swallowed here rather than failing the turn itself - a skipped compaction just means this
   * turn's request may come in over budget and fail on its own, exactly the pre-existing behavior
   * before compaction existed, not a new regression. Nothing is mutated unless the summarization
   * call actually succeeds, so a failure never leaves history in a half-compacted state.
   */
  private async maybeCompact(
    contextWindow: number,
    settings: CompactionSettings,
    onEvent: (event: AgentEvent) => void,
    onEntry: (entry: ContextEntry) => void,
    onProviderCall: (call: { request: CompletionRequest; response: CompletionResponse }) => void,
    signal?: AbortSignal,
    modeInstruction?: string,
  ): Promise<void> {
    // Hybrid real+delta estimate - see hybridPromptTokenEstimate's own doc comment and
    // maybeMicroCompact's identical swap above.
    const effectiveVisible = this.hybridPromptTokenEstimate(modeInstruction);
    if (!shouldCompact(effectiveVisible, contextWindow, settings.reserveTokens)) return;
    const cutPoint = findCutPoint(this.entries, settings.keepRecentTokens);
    if (cutPoint === 0) return; // no safe turn boundary to cut at yet - skip this round

    const toCompact = this.entries.slice(0, cutPoint);
    // An earlier compaction's own summary entry, if this round's cut point has pushed it into the
    // region being folded away again - its stored summary seeds an update instead of a fresh
    // regenerate-from-scratch call (§2.3's iterative-summary requirement).
    let previousSummary: unknown;
    for (let i = toCompact.length - 1; i >= 0; i--) {
      const entry = toCompact[i];
      if (entry.type === 'ai' && entry.sub_type === 'compaction') {
        try {
          previousSummary = (JSON.parse(entry.content) as { summary?: unknown }).summary;
        } catch {
          // Malformed stored content - proceed without a seed rather than failing compaction.
        }
        break;
      }
    }

    let summary: unknown;
    const tokensBefore = this.visibleTokenEstimate;
    // 70% of the reserve held for this call's own prompt, in chars (this codebase's own
    // chars/4 ~= tokens convention) - leaves headroom in the same reserve for the system prompt
    // above and the JSON response itself, rather than letting `toCompact` (which has no upper
    // bound of its own - see buildCompactionPrompt's own doc comment on the probed gap this
    // closes) consume the entire budget or more.
    const maxContentChars = Math.max(4000, Math.floor(settings.reserveTokens * 0.7) * 4);
    const request: CompletionRequest = {
      systemPrompt:
        'You produce structured JSON summaries of coding-agent conversation history for context compaction. Output only the JSON object, nothing else.',
      messages: [
        { role: 'user', content: buildCompactionPrompt({ entries: toCompact, previousSummary, maxContentChars }) },
      ],
      tools: [],
      signal,
    };
    try {
      const response = await this.provider.complete(request);
      onProviderCall({ request, response });
      summary = parseSummary(response.content);
    } catch {
      return; // best-effort - see this method's own doc comment
    }

    // Real flaw found via direct hands-on observation (not just probing): compacting a small
    // region can produce a net *increase* - a structured JSON summary (user_intent/
    // technical_concepts/files/errors_and_fixes/problem_solving/pending_tasks/current_work/
    // next_step) has its own baseline size, and when it replaces only a handful of small entries,
    // the summary can cost more than what it removed. Measured before mutating anything (never
    // partially applies a compaction only to discover afterward it should be undone) - if the
    // summary wouldn't actually shrink the visible history, this round is declined the same
    // best-effort way a failed provider call already is above: no mutation, no entry, no event.
    // shouldCompact() will simply be asked again next check, once more real history has
    // accumulated and there's an actual net win to make.
    const firstKeptEntryId = this.entries[cutPoint]?.id;
    const summaryEntry = aiCompactionEntry(summary, firstKeptEntryId, tokensBefore);
    const tokensRemoved = toCompact.reduce((sum, e) => sum + (e.agent_visible !== false ? estimateTokens(e) : 0), 0);
    if (estimateTokens(summaryEntry) >= tokensRemoved) return;

    // Flip visibility via deindex/mutate/reindex so visibleTokenEstimate's bookkeeping (owned by
    // those two methods) stays correct - never touch agent_visible directly without going through
    // them. Entries an earlier compaction already hid are skipped, not double-counted.
    for (const entry of toCompact) {
      if (entry.agent_visible === false) continue;
      this.deindexEntry(entry);
      entry.agent_visible = false;
      this.indexEntry(entry);
      this.releaseEntryContent(entry);
    }

    // Spliced in at the cut point itself (not appended to the end) so it sits exactly where the
    // hidden entries used to be in reading order - toWireMessages() then naturally emits it as
    // the first thing the model sees, immediately before the untouched, still-verbatim tail.
    this.entries.splice(cutPoint, 0, summaryEntry);
    this.indexEntry(summaryEntry);
    onEntry(summaryEntry);
    onEvent({
      type: 'compaction',
      text: `Compacted ${toCompact.length} older entries (~${tokensBefore} -> ~${this.visibleTokenEstimate} tokens estimated).`,
    });
  }

  async run(userMessage: string, options: RunOptions = {}): Promise<string> {
    const configuredMaxIterations = options.maxIterations ?? 25;
    const maxIterations = configuredMaxIterations > 0 ? configuredMaxIterations : Infinity;
    const onEvent = options.onEvent ?? (() => {});
    const onEntry = options.onEntry ?? (() => {});
    const onProviderCall = options.onProviderCall ?? (() => {});

    // Checked before this turn's own user message is appended, so the check reflects exactly
    // what's already in history from prior turns - a completed compaction here is committed
    // regardless of whether this turn itself later aborts (it isn't part of what `rollbackTo`
    // below undoes; it already happened as its own, prior, successful step). Tier 2 (free) always
    // runs before tier 3 (one real API call) - §2.3's cheap-first ordering.
    // Real bug found via direct reproduction (2026-10-02): even with the cutoffChain fix below,
    // a resumed session whose saved history was ALREADY over the server's hard limit (the
    // "/resume dies out" case - two failed live runs, both rejected with the same
    // exceed_context_size_error the first live turn hit) had no way to fail gracefully - it just
    // repeated the same raw server 400 every time. Verified directly against real Claude Code's
    // own hard-stop (`src/query.ts`'s blocking-limit check, `calculateTokenWarningState` in
    // `services/compact/autoCompact.ts`) via source read, not guessed: same idea here - after
    // compaction has had its chance, if the next request would still be too close to the hard
    // limit, refuse to send it and say so clearly instead of letting the server reject it.
    // Started at 3000 (matching real Claude Code's own MANUAL_COMPACT_BUFFER_TOKENS exactly,
    // confirmed in source) but that wasn't enough in practice: confirmed live AGAIN (2026-10-03,
    // same 4-session stress test, request 57345 > 57344 n_ctx) - the hybrid estimate's real-usage
    // anchor was confirmed fresh every round (verified directly: a standalone curl against the
    // live server shows llama-server DOES send `usage` on a max_tokens cutoff, no staleness bug),
    // so the miss came from the ESTIMATED DELTA itself - one round's dense code (a hand-written
    // tokenizer/interpreter, lots of brackets/punctuation) likely tokenizes denser than chars/4
    // assumes, the same density problem real Claude Code's own reference handles for JSON
    // specifically (contextwindow.md's bytesPerTokenForFileType) but we don't yet handle for code.
    // Without real calibration data to fix the estimate itself, widened the safety margin instead
    // - cheap (a bit of earlier compaction) against a demonstrated multi-thousand-token miss in a
    // single round. 8000 cap / 15% comfortably covers the ~3000-token miss actually observed, with
    // real headroom left over; still scaled down for a tiny unit-test window so it can't swallow
    // the whole window on its own.
    const hardStopReserveTokens = (contextWindow: number): number => Math.min(8000, Math.floor(contextWindow * 0.15));
    const hardStopMessage = (): string | null => {
      if (!options.contextWindow) return null;
      const estimate = this.hybridPromptTokenEstimate(options.modeInstruction);
      if (estimate < options.contextWindow - hardStopReserveTokens(options.contextWindow)) return null;
      return `Context window is nearly full (~${estimate.toLocaleString()} / ${options.contextWindow.toLocaleString()} tokens) and compaction couldn't free enough room to continue safely. Try /clear, or a narrower request.`;
    };

    // Per direct instruction (2026-10-03): check before every send - if usage is at/above 80% of
    // the window, pause (don't send yet) and compact, targeting 25% headroom (i.e. back down to
    // ~75%), THEN send. This runs AFTER the normal every-round compaction calls below (which use
    // whatever reserveTokens/microCompactReserveTokens this run was actually configured with) -
    // this is a separate, simple percentage-based escalation for when that wasn't enough: forces
    // both tiers to retry against a 25%-of-window reserve regardless of their own configured
    // numbers, bounded to a few attempts (same bounded-retry shape hermes-agent and real Claude
    // Code's own blocking-limit skip-conditions use - source-verified, not guessed) so a model that
    // keeps regenerating content compaction can't shrink still stops retrying eventually rather
    // than looping forever. Falls through to hardStopMessage() above as the final backstop if even
    // this can't get below 80%.
    const COMPACT_PAUSE_RATIO = 0.8;
    const COMPACT_TARGET_RATIO = 0.75;
    const MAX_FORCED_COMPACT_ATTEMPTS = 3;
    const pauseAndCompactIfOverEighty = async (): Promise<void> => {
      if (!options.contextWindow) return;
      const contextWindow = options.contextWindow;
      for (let attempt = 0; attempt < MAX_FORCED_COMPACT_ATTEMPTS; attempt++) {
        const before = this.hybridPromptTokenEstimate(options.modeInstruction);
        if (before < contextWindow * COMPACT_PAUSE_RATIO) return; // under 80% - nothing to do
        const forcedReserve = Math.floor(contextWindow * (1 - COMPACT_TARGET_RATIO));
        const forcedSettings: CompactionSettings = {
          ...(options.compactionSettings ?? compactionSettingsForWindow(contextWindow)),
          reserveTokens: forcedReserve,
          microCompactReserveTokens: forcedReserve,
        };
        this.maybeMicroCompact(contextWindow, forcedSettings, onEvent, onEntry, options.modeInstruction);
        await this.maybeCompact(
          contextWindow,
          forcedSettings,
          onEvent,
          onEntry,
          onProviderCall,
          options.signal,
          options.modeInstruction,
        );
        const after = this.hybridPromptTokenEstimate(options.modeInstruction);
        if (after >= before) return; // no progress this round - stop retrying, let hardStopMessage decide
      }
    };

    if (options.contextWindow) {
      const compactionSettings = options.compactionSettings ?? compactionSettingsForWindow(options.contextWindow);
      this.maybeMicroCompact(options.contextWindow, compactionSettings, onEvent, onEntry, options.modeInstruction);
      await this.maybeCompact(
        options.contextWindow,
        compactionSettings,
        onEvent,
        onEntry,
        onProviderCall,
        options.signal,
        options.modeInstruction,
      );
      await pauseAndCompactIfOverEighty();
      const preTurnHardStop = hardStopMessage();
      if (preTurnHardStop) {
        onEvent({ type: 'warning', text: preTurnHardStop });
        return '';
      }
    }

    // Saved so an abort mid-turn can roll history back to exactly this point - see the catch
    // block below.
    const lengthBeforeTurn = this.entries.length;
    this.appendEntry(userInputEntry(userMessage, options.images), onEntry);
    const toolDefs = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const systemPromptForRequest = options.modeInstruction
      ? `${this.systemPrompt}\n\n${options.modeInstruction}`
      : this.systemPrompt;

    // Real bug found via hands-on testing, 2026-09-26: abort was previously detected only
    // *reactively*, when the provider call itself happened to reject because of the signal - so
    // a mid-turn Escape (e.g. on a tool confirmation dialog, which isn't wired to the signal at
    // all) didn't actually stop anything; the loop just carried on to the next tool call or the
    // next provider round regardless, showing "every other next window" of confirmations. Checked
    // proactively instead, before each provider round and before each tool call, so an abort
    // requested at any point takes effect at the very next opportunity rather than only if the
    // network layer happens to notice it.
    const checkAborted = (): void => {
      if (options.signal?.aborted) {
        this.rollbackTo(lengthBeforeTurn);
        throw new AbortedError(userMessage);
      }
    };

    // Real bug found via direct reproduction (2026-10-02): a max_tokens-cutoff think block (often
    // tens of thousands of tokens) has no tool_call_id, so MicroCompact never touches it, and
    // there's no new user message anywhere in this unbroken turn for a real compaction to cut at
    // (see findCutPoint()'s own doc comment) - neither existing compaction tier can reach it.
    // Confirmed live twice: once as an unbroken chain of cutoffs (context hit 138% of n_ctx,
    // request rejected outright), and again when the round AFTER a cutoff made a tool call
    // instead (the original cutoff entry just sat there as permanent dead weight - 63622 tokens
    // against a 57344-token server). Tracks the current cutoff round's think/response entries so
    // the moment we move past them - whether the next round is another cutoff OR a tool call -
    // they get hidden via hidePendingCutoffChain() below. Only the newest round's content is what
    // the model actually needs to continue from.
    const cutoffChain: ContextEntry[] = [];
    let emptyTurnRetries = 0;
    let hadToolWork = false;
    // Set after a cutoff with no tool call. Sent as a transient user turn on the next request only,
    // never stored: a closed assistant turn plus a fresh generation prompt makes the model restate
    // the cut-off text instead of continuing it (checked live against the server's chat template).
    let continueAfterCutoff = false;
    const hidePendingCutoffChain = (): void => {
      if (cutoffChain.length === 0) return;
      let tokensFreed = 0;
      for (const entry of cutoffChain) {
        tokensFreed += estimateTokens(entry);
        this.deindexEntry(entry);
        entry.agent_visible = false;
        this.indexEntry(entry);
        this.releaseEntryContent(entry);
      }
      const pruneEntry = aiPruneEntry(
        cutoffChain.length,
        tokensFreed,
        `superseded max_tokens-cutoff entr${cutoffChain.length === 1 ? 'y' : 'ies'}`,
      );
      this.entries.push(pruneEntry);
      this.indexEntry(pruneEntry);
      onEntry(pruneEntry);
      onEvent({
        type: 'prune',
        text: `Pruned ${cutoffChain.length} superseded max_tokens-cutoff entr${cutoffChain.length === 1 ? 'y' : 'ies'} from an earlier retry round (~${tokensFreed} tokens freed).`,
      });
      cutoffChain.length = 0;
    };

    for (let i = 0; i < maxIterations; i++) {
      checkAborted();
      let response;
      // Fresh per provider call - `<think>` open/close state can't carry over between calls (each
      // call is its own complete-or-not response). Strips literal <think>/</think> markers out of
      // the live preview only (never the persisted record, which still goes through
      // splitThinkBlock() on the complete text below) - a real invariant this codebase already
      // guarantees for the final answer, extended here to cover the streamed preview too (see
      // streamFilter.ts's own doc comment for why this needs to be stateful across chunks).
      const thinkFilter = createThinkTagStripper((text, kind) => onEvent({ type: 'delta', text, kind }));
      let streamed = false;
      // Snapshotted right before the request goes out - response.usage.inputTokens (below) will
      // report what was actually sent as of exactly this moment, so this is the estimate value
      // that real count corresponds to. See hybridPromptTokenEstimate()'s own doc comment.
      const visibleEstimateAtSendTime = this.visibleTokenEstimate;
      // Real bug found via direct reproduction (2026-10-03): without this, max_tokens stayed a
      // single static value (half the context window, set once at startup) for every request
      // regardless of prompt size - confirmed live, a single response ran 9+ minutes generating
      // 16,289 tokens straight before the SERVER cut it off at its hard n_ctx (`truncated: 1`),
      // not a clean stop from us. Computed fresh each round from the actual prompt estimate about
      // to be sent, reusing the same safety margin as the hard-stop check below so the model is
      // never even ALLOWED to generate past where that check would refuse the next request anyway
      // - never larger than whatever max_tokens this provider was actually configured with.
      const dynamicMaxTokens = options.contextWindow
        ? Math.max(
            256,
            Math.min(
              // Per-response ceiling. Was contextWindow/2 (matching cli.ts's original static
              // setter) and that turned out to be the single biggest cause of the runaway rounds
              // this whole fix chain was chasing - confirmed with hard numbers from a real run's
              // provider-call log (tmp.tmp3, 2026-10-03): with a small prompt the half-window cap
              // applied, the model was ALLOWED 28,672 output tokens, and it used 28,300 of them in
              // one planning block - taking context from 21K to 49K in a single round, after which
              // every later round is starved and nothing can recover. A single response must never
              // be able to eat half the window.
              //
              // First attempt at this was a flat 8192 ceiling, and that was too tight in the other
              // direction - confirmed live the same day on a 229K window at only 16% use: a
              // write_file with a large `content` got cut off mid-JSON by the cap, which used to
              // crash the turn outright (see parseSseStream's own comment for that half of the
              // fix). 8192 was also the binding constraint on BOTH window sizes, i.e. only 3.6% of
              // a 229K window, throttling legitimate file writes for no benefit. 25% of the window
              // with a 32768 absolute ceiling keeps real file writes workable (14,336 at 57K;
              // 32,768 at 229K) while staying well under the half-window value that caused the
              // original runaway - and this ceiling is only a backstop anyway: the remaining-budget
              // term below is the real constraint as context fills.
              Math.min(32768, Math.floor(options.contextWindow / 4)),
              options.contextWindow - this.hybridPromptTokenEstimate(options.modeInstruction) - hardStopReserveTokens(options.contextWindow),
            ),
          )
        : undefined;
      const request: CompletionRequest = {
        systemPrompt: systemPromptForRequest,
        messages: continueAfterCutoff
          ? [...toWireMessages(this.entries), { role: 'user', content: CUTOFF_CONTINUE_PROMPT }]
          : toWireMessages(this.entries),
        tools: toolDefs,
        signal: options.signal,
        maxTokens: dynamicMaxTokens,
        onToken: (delta, kind) => {
          streamed = true;
          thinkFilter.feed(delta, kind);
        },
      };
      try {
        response = await this.provider.complete(request);
        onProviderCall({ request, response });
        thinkFilter.flush();
        if (response.usage) {
          const plainEstimateAtSend = visibleEstimateAtSendTime + this.overheadTokenEstimate(options.modeInstruction);
          if (plainEstimateAtSend > 0) {
            this.tokenRatio = Math.min(MAX_TOKEN_RATIO, Math.max(MIN_TOKEN_RATIO, response.usage.inputTokens / plainEstimateAtSend));
          }
          this.lastRealPromptTokens = response.usage.inputTokens;
          this.visibleEstimateAtLastRealCount = visibleEstimateAtSendTime;
        }
      } catch (err) {
        // Checked on the caller's own signal, not the error's name/type - a provider may wrap
        // or rename the underlying abort error (e.g. LocalProvider merges this signal with its
        // own request timeout via AbortSignal.any, so a plain `err.name` check can't tell "the
        // user cancelled" apart from "the provider's own timeout fired" the way this can).
        if (options.signal?.aborted) {
          this.rollbackTo(lengthBeforeTurn);
          throw new AbortedError(userMessage);
        }
        // The local server cannot answer (not reachable, or still loading its model): this was never a real
        // attempt, so roll the turn back as if it had not been sent and hand the message to the caller, which
        // waits for the server and puts it back in the input box (same contract as AbortedError.prompt).
        if (err instanceof ServerUnavailableError) {
          this.rollbackTo(lengthBeforeTurn);
          err.prompt = userMessage;
        }
        throw err;
      }

      this.usage.requestCount += 1;
      if (response.usage) {
        this.usage.inputTokens += response.usage.inputTokens;
        this.usage.outputTokens += response.usage.outputTokens;
      }

      // Real bug found via direct reproduction: a response cut off by the provider's own
      // max_tokens cap (most often mid-<think>, before the model ever reaches real content or a
      // tool call) used to fall through silently - same code path as a normal finish, no
      // indication anything was truncated. stopReason alone can't distinguish "hit the cap while
      // thinking" from "hit it after a full, satisfying answer", so this always surfaces - better
      // an occasional over-cautious note than another silent empty turn.
      if (response.stopReason === 'max_tokens') {
        onEvent({
          type: 'warning',
          text: 'Response cut off at the output limit (max_tokens) - continuing from where it stopped.',
        });
      }

      // Per direct instruction 2026-09-26: a local model's inline `<think>...</think>` reasoning
      // is split out of the raw response text here, before it ever reaches history, the final
      // answer, or the caller's onEvent - see `splitThinkBlock()` (contextEntry.ts) for the
      // parsing rule (a closed block captured in full; an unclosed one cut at the next newline
      // rather than swallowing the rest of the message).
      const { think, response: responseText } = splitThinkBlock(response.content);
      // A redacted thinking block (Anthropic-only) has no readable text at all - `think` stays
      // empty in that case (there's nothing for splitThinkBlock() to find), but the opaque
      // redacted_thinking data still needs an entry to carry it forward for replay, or it's lost.
      const roundEntries: ContextEntry[] = [];
      if (think || response.redactedThinking) {
        if (think) onEvent({ type: 'think', text: think, streamed });
        const thinkEntry = aiThinkEntry(think ?? '', response.thinkingSignature, response.redactedThinking);
        this.appendEntry(thinkEntry, onEntry);
        roundEntries.push(thinkEntry);
      }
      if (responseText) {
        onEvent({ type: 'text', text: responseText, streamed });
      }

      const isToolUse = response.stopReason === 'tool_use' && response.toolCalls.length > 0;
      const responseEntry = aiResponseEntry(responseText);
      this.appendEntry(responseEntry, onEntry);
      roundEntries.push(responseEntry);

      // Real bug found via direct reproduction (2026-10-02, a --parallel 4 stress test): a
      // max_tokens cutoff with no tool call used to return here immediately, ending the whole
      // turn - most often caught mid-<think>, before the model ever reached a tool call or a
      // real answer, silently stranding the user with nothing done. Looping back for another
      // provider call instead (same as a tool_use continuation) lets the model pick up where it
      // left off - the cut-off content is already in history via appendEntry above. Bounded by
      // the same maxIterations cap as every other round, so a model that never converges still
      // stops eventually rather than looping forever.
      const isMaxTokensCutoff = response.stopReason === 'max_tokens';
      continueAfterCutoff = isMaxTokensCutoff && response.toolCalls.length === 0;
      // Backstop (2026-10-03): an empty completion that isn't a cutoff and isn't a tool call is
      // almost always the model emitting EOS straight away, not a real answer - the turn would
      // otherwise end silently with nothing done. Retry once with an explicit nudge, visibly, and
      // only once per streak (reset whenever real work happens).
      // A short reply ending mid-sentence with no tool call (2026-10-04: "...Now", 17 tokens,
      // end_turn - the turn ended there silently) is the same failure as an empty one. Only counted
      // once the turn has done real tool work, so a plain one-line answer to a question still ends.
      const trimmedReply = responseText.trim();
      const isEmptyReply = trimmedReply === '';
      // Narrow on purpose: only a reply that visibly trails off (a dangling connective or a
      // trailing comma/colon). A normal short final answer after tool work must still end the turn.
      const isMidSentence =
        hadToolWork &&
        trimmedReply.length > 0 &&
        trimmedReply.length < 300 &&
        (/[,;:]$/.test(trimmedReply) ||
          /\b(now|and|or|the|a|an|to|then|next|so|but|let|let's|with|of|for|in|on|is|are|i'll|i'm|we'll)$/i.test(trimmedReply));
      const isIncompleteEndTurn = !isToolUse && !isMaxTokensCutoff && (isEmptyReply || isMidSentence);
      if (isIncompleteEndTurn && emptyTurnRetries < 1) {
        emptyTurnRetries += 1;
        onEvent({
          type: 'warning',
          text: isEmptyReply
            ? 'The model returned an empty reply - asking it to continue once.'
            : 'The model stopped mid-reply - asking it to continue once.',
        });
        this.appendEntry(userInputEntry('Continue with the task.'), onEntry);
        continue;
      }
      if (isToolUse) {
        emptyTurnRetries = 0;
        hadToolWork = true;
      }
      if (!isToolUse && !isMaxTokensCutoff) {
        return responseText;
      }

      // Either way, we're moving past whatever cutoff round was pending (if any) - a tool call or
      // a fresh cutoff both supersede it equally; only re-arm the chain when THIS round is itself
      // another cutoff that might in turn need hiding later.
      hidePendingCutoffChain();
      if (isMaxTokensCutoff) {
        cutoffChain.push(...roundEntries);
      }

      for (const call of response.toolCalls) {
        checkAborted();
        onEvent({ type: 'tool_call', toolName: call.name, toolInput: call.input });
        const tool = this.tools.find((t) => t.name === call.name);
        this.appendEntry(aiToolCallEntry(call, tool?.mutating), onEntry);
        let output: string;
        if (!tool) {
          output = `Error: no tool registered with name "${call.name}"`;
        } else if (options.toolPolicy && (await options.toolPolicy(tool, call.input)) === 'deny') {
          output = `Blocked by the current mode: ${call.name} was not executed.`;
        } else {
          output = await tool.execute(call.input);
        }
        onEvent({ type: 'tool_result', toolName: call.name, toolOutput: output });
        this.appendEntry(aiToolCallResponseEntry(call.id, output, tool?.mutating), onEntry);
      }

      // Real bug found via direct user report: the only other maybeCompact() call (above, before
      // this loop) runs once, before this turn's own tool-calling ever starts - it has no way to
      // catch a *single* long turn (many tool calls, no new user message in between) growing past
      // the context limit entirely on its own. Reproduced directly: a 60+-tool-call research turn
      // grew to 114% of the model's context window with zero chance to compact along the way, and
      // crashed on whatever provider request finally exceeded it (`exceed_context_size_error`).
      // Checked here, after this iteration's tool calls are appended and only when the loop is
      // actually going to continue (an `!isToolUse` turn already returned above, so there is no
      // next request to protect) - never at the top of the loop, which was tried first and found
      // to double up with the pre-loop check on iteration 0 specifically: with zero new entries
      // appended between them, an immediate retry of a compaction that the pre-loop check just
      // failed can spuriously "succeed" against a response never meant to be treated as a summary
      // (caught by a regression test - `loopCompaction.test.ts`'s "a failed compaction call is
      // swallowed" - failing an unrelated assertion once the top-of-loop placement was added).
      // Cheap when it doesn't fire (visibleTokenEstimate is an O(1) running counter) - only
      // actually costs anything on the iteration where compaction genuinely needs to happen.
      // Tier 2 first, same cheap-first ordering as the pre-loop check above - safe to call here
      // unconditionally (unlike tier 3's async retry hazard above): it's synchronous, can't fail,
      // and already-pruned pairs are skipped, so calling it again with zero new entries since the
      // last pass is simply a cheap, correct no-op.
      if (options.contextWindow) {
        const compactionSettings = options.compactionSettings ?? compactionSettingsForWindow(options.contextWindow);
        this.maybeMicroCompact(options.contextWindow, compactionSettings, onEvent, onEntry, options.modeInstruction);
        await this.maybeCompact(
          options.contextWindow,
          compactionSettings,
          onEvent,
          onEntry,
          onProviderCall,
          options.signal,
          options.modeInstruction,
        );
        await pauseAndCompactIfOverEighty();
        const hardStop = hardStopMessage();
        if (hardStop) {
          onEvent({ type: 'warning', text: hardStop });
          return responseText;
        }
      }
    }

    throw new MaxIterationsError(maxIterations);
  }
}
