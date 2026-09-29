import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import {
  aiCompactionEntry,
  aiResponseEntry,
  aiThinkEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  estimateTokens,
  splitThinkBlock,
  toWireMessages,
  userInputEntry,
  type ContextEntry,
} from './contextEntry.js';
import {
  buildCompactionPrompt,
  findCutPoint,
  parseSummary,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from './compaction.js';
import { createThinkTagStripper } from './streamFilter.js';

export interface AgentEvent {
  type: 'text' | 'think' | 'tool_call' | 'tool_result' | 'compaction' | 'delta' | 'warning';
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
  ): Promise<void> {
    if (!shouldCompact(this.visibleTokenEstimate, contextWindow, settings.reserveTokens)) return;
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
    const request: CompletionRequest = {
      systemPrompt:
        'You produce structured JSON summaries of coding-agent conversation history for context compaction. Output only the JSON object, nothing else.',
      messages: [{ role: 'user', content: buildCompactionPrompt({ entries: toCompact, previousSummary }) }],
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

    // Flip visibility via deindex/mutate/reindex so visibleTokenEstimate's bookkeeping (owned by
    // those two methods) stays correct - never touch agent_visible directly without going through
    // them. Entries an earlier compaction already hid are skipped, not double-counted.
    for (const entry of toCompact) {
      if (entry.agent_visible === false) continue;
      this.deindexEntry(entry);
      entry.agent_visible = false;
      this.indexEntry(entry);
    }

    const firstKeptEntryId = this.entries[cutPoint]?.id;
    const summaryEntry = aiCompactionEntry(summary, firstKeptEntryId, tokensBefore);
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
    // below undoes; it already happened as its own, prior, successful step).
    if (options.contextWindow) {
      await this.maybeCompact(
        options.contextWindow,
        options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS,
        onEvent,
        onEntry,
        onProviderCall,
        options.signal,
      );
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
      const request: CompletionRequest = {
        systemPrompt: systemPromptForRequest,
        messages: toWireMessages(this.entries),
        tools: toolDefs,
        signal: options.signal,
        onToken: (delta, kind) => {
          streamed = true;
          thinkFilter.feed(delta, kind);
        },
      };
      try {
        response = await this.provider.complete(request);
        onProviderCall({ request, response });
        thinkFilter.flush();
      } catch (err) {
        // Checked on the caller's own signal, not the error's name/type - a provider may wrap
        // or rename the underlying abort error (e.g. LocalProvider merges this signal with its
        // own request timeout via AbortSignal.any, so a plain `err.name` check can't tell "the
        // user cancelled" apart from "the provider's own timeout fired" the way this can).
        if (options.signal?.aborted) {
          this.rollbackTo(lengthBeforeTurn);
          throw new AbortedError(userMessage);
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
          text: 'Response cut off - the model hit its max_tokens output limit before finishing. Consider raising contextWindow in config.json (max_tokens is derived from it) or asking a narrower question.',
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
      if (think || response.redactedThinking) {
        if (think) onEvent({ type: 'think', text: think, streamed });
        this.appendEntry(aiThinkEntry(think ?? '', response.thinkingSignature, response.redactedThinking), onEntry);
      }
      if (responseText) {
        onEvent({ type: 'text', text: responseText, streamed });
      }

      const isToolUse = response.stopReason === 'tool_use' && response.toolCalls.length > 0;
      this.appendEntry(aiResponseEntry(responseText), onEntry);

      if (!isToolUse) {
        return responseText;
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
      if (options.contextWindow) {
        await this.maybeCompact(
          options.contextWindow,
          options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS,
          onEvent,
          onEntry,
          onProviderCall,
          options.signal,
        );
      }
    }

    throw new MaxIterationsError(maxIterations);
  }
}
