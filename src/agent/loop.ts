import type { LLMProvider, Message } from '../providers/types.js';
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

export interface AgentEvent {
  type: 'text' | 'think' | 'tool_call' | 'tool_result' | 'compaction';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}

export interface RunOptions {
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
    try {
      const response = await this.provider.complete({
        systemPrompt:
          'You produce structured JSON summaries of coding-agent conversation history for context compaction. Output only the JSON object, nothing else.',
        messages: [{ role: 'user', content: buildCompactionPrompt({ entries: toCompact, previousSummary }) }],
        tools: [],
        signal,
      });
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
    const maxIterations = options.maxIterations ?? 25;
    const onEvent = options.onEvent ?? (() => {});
    const onEntry = options.onEntry ?? (() => {});

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
      try {
        response = await this.provider.complete({
          systemPrompt: systemPromptForRequest,
          messages: toWireMessages(this.entries),
          tools: toolDefs,
          signal: options.signal,
        });
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

      // Per direct instruction 2026-09-26: a local model's inline `<think>...</think>` reasoning
      // is split out of the raw response text here, before it ever reaches history, the final
      // answer, or the caller's onEvent - see `splitThinkBlock()` (contextEntry.ts) for the
      // parsing rule (a closed block captured in full; an unclosed one cut at the next newline
      // rather than swallowing the rest of the message).
      const { think, response: responseText } = splitThinkBlock(response.content);
      if (think) {
        onEvent({ type: 'think', text: think });
        this.appendEntry(aiThinkEntry(think), onEntry);
      }
      if (responseText) {
        onEvent({ type: 'text', text: responseText });
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
    }

    throw new MaxIterationsError(maxIterations);
  }
}
