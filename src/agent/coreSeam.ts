import type { ContextEntry } from './contextEntry.js';
import type { Tool } from '../tools/types.js';

/**
 * The core tier's internal seam - design doc §5.7, decided 2026-10-17.
 *
 * **Why this file exists at all.** §5.1's revision moved four features out of the MCP plugin tier
 * and into first-party in-process code: §4's infinite-context store, the Code Graph intercepting
 * `grep`/`glob`-class calls, smart context search, and rollback to a sliding context window. All
 * four need to change *what goes on the wire this turn* or *what a tool call returns*, which MCP
 * structurally cannot express (a server can add a tool, never wrap one). But "it is all
 * first-party now" is not an architecture: four components each reaching into `AgentLoop`'s
 * private `entries` is the race/corruption risk §2.2 flagged on 2026-09-22, and would be a worse
 * outcome than the plugin framing rather than a better one. So they register here instead, and
 * nothing else reaches in.
 *
 * **Deliberately internal, not public API** (§5.7's third open question, settled here). This is
 * not exported from the package root and carries no compatibility promise. A third party extends
 * o4c through MCP or (later) skills - that is what those tiers are for. Keeping this internal is
 * what makes it cheap to change while the four features are still being designed.
 *
 * **Nothing registers on it yet.** This is the seam only; the features are checklist items 13,
 * 22, 23 and 40.
 */

/** What a `buildRequest` hook is told about the request being assembled. */
export interface RequestBuild {
  /**
   * The entry list as the pipeline has it so far: `AgentLoop`'s own history for the first hook,
   * the previous hook's return value for each one after it.
   *
   * Readonly, and that is the whole point - see `CoreComponent.buildRequest`.
   */
  readonly entries: readonly ContextEntry[];
  /** The model's real context size when known, straight from `RunOptions.contextWindow`. */
  readonly contextWindow?: number;
  /** What this request will allow the model to generate, so a hook can budget the rest. */
  readonly maxTokens?: number;
  /**
   * Real tokens per `estimateTokens` token, as the loop has calibrated it from the provider's own
   * counts. A hook that budgets in estimated tokens divides a real-token budget by this. Without
   * it a "35% of the window" bound measured in chars/4 came out near 60% on the tmp4 long run,
   * where code and JSON ran 1.8 real tokens per estimated one (2026-11-01). Absent means 1.
   */
  readonly tokenRatio?: number;
  /**
   * True when the loop is projecting the next request before the user's new message is in
   * history - its pre-turn compaction checks run first, so a pre-turn hard stop can return without
   * recording the message. No turn in `entries` is running then, which matters to a hook that
   * treats the last turn as the current one. Found on the tmp4 long run (2026-11-01): curated kept
   * the previous 50-call turn whole as "current", and the pre-turn check fired at 83% on that.
   */
  readonly beforeNewMessage?: boolean;
  /**
   * Shows the user one dim `[info]` line - for a hook that adds something the model will read
   * but the screen would otherwise never show (the `pointer` hint, found missing on the live check
   * 2026-10-31). Absent in callers with no screen; a hook must not depend on it.
   */
  readonly info?: (text: string) => void;
}

/** What an `aroundTool` hook is told about the call it may answer instead of executing. */
export interface ToolCallContext {
  readonly tool: Tool;
  readonly input: Record<string, unknown>;
}

/**
 * One core component. Every hook is optional; a component implements only the ones it needs.
 *
 * `name` is required and is used in the warning text when a hook misbehaves - a degraded turn
 * that cannot say *which* component degraded it is most of the way to undebuggable.
 */
export interface CoreComponent {
  readonly name: string;

  /**
   * Hook 1 of 3 - an entry was appended to history.
   *
   * Observe-only, and intentionally the same shape as `RunOptions.onEntry`, which already existed
   * for this exact purpose and which §5.7 says not to redesign. Registering here rather than
   * passing `onEntry` directly only means a component declares itself in one place.
   */
  onEntry?(entry: ContextEntry): void;

  /**
   * Hook 2 of 3 - decide what this request is built from.
   *
   * **Projection, not mutation** (§5.7's second open question, settled here). A hook receives a
   * readonly list and returns the list to build from; it never touches `AgentLoop.entries`. Two
   * reasons, and the second is the one that decided it:
   *
   * - It keeps §2.2's write-access caution satisfied by construction rather than by discipline.
   * - It is what the features actually need. Smart search *selects* entries, a sliding window
   *   *hides* them, and the infinite-context store *adds* retrieved ones that were never in this
   *   session's history at all. A returned list may therefore contain entries `AgentLoop` has
   *   never seen, and they live for exactly one request - which is the correct lifetime for a
   *   retrieval result and is unexpressible if the hook mutates shared state instead.
   *
   * **The accounting measures this projection, as of 2026-10-22.** It did not when the seam was
   * built: the compaction triggers and the pre-send hard stop read `visibleTokenEstimate`, the
   * whole visible history, so a hook that *hid* entries was ignored by the very machinery that
   * decides whether to compact - and compaction would then spend a provider call summarising
   * material the hook had already stopped sending. `AgentLoop.refreshRequestProjection` runs this
   * pipeline before anything reads an estimate and caches the result per entry version; see
   * `src/test/seamAccounting.test.ts`.
   *
   * What that does **not** solve is a hook that *adds* entries. The estimate will see them, which
   * is a strict improvement, but nothing stops a retrieval component from injecting more than the
   * window can hold in the first place - which is why `contextWindow` and `maxTokens` are on
   * `RequestBuild`. A hook still budgets itself; the difference is that it is no longer invisible
   * to the accounting if it gets it wrong.
   */
  buildRequest?(build: RequestBuild): readonly ContextEntry[] | Promise<readonly ContextEntry[]>;

  /**
   * Hook 3 of 3 - wrap a tool call, optionally answering it without executing.
   *
   * Classic middleware: call `next()` to let the real tool (or the next hook) run, or return a
   * string to answer on its own. `next()` is what lets the Code Graph decline the calls it has no
   * index for and intercept only the ones it can answer more cheaply.
   *
   * **Runs only on the approved path.** `AgentLoop` consults `RunOptions.toolPolicy` first and
   * only reaches this seam for a call the mode and the user allowed, so a component can never
   * become a way around the approval gate. A denied or declined call is answered by the loop and
   * no hook sees it.
   */
  aroundTool?(call: ToolCallContext, next: () => Promise<string>): Promise<string>;

  /**
   * Hook 4 - a note for the model at the start of a user turn (plan 0006 A8).
   *
   * `buildRequest` changes what is sent but not history, so text it adds to a message has to be
   * re-added on every request - and on a hybrid model like Qwen3.8 any difference from the
   * previous request re-processes everything after it. A component whose information changes
   * now and then (the active plan) returns it here instead: the loop appends it to history as a
   * note, once, only when it differs from the last note this component left, folded into the user
   * message of the turn. It never moves afterwards. Called once per user turn with that turn's
   * message (the `pointer` hint searches with it); undefined = nothing. `info` shows a line to the
   * user, like `RequestBuild.info`.
   */
  turnNote?(turn: { message: string; info?: (text: string) => void }): string | undefined;
}

/** Reports a degraded hook. Matches `AgentEvent`'s `warning` channel without importing it. */
export type SeamWarning = (message: string) => void;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Holds the registered components and runs each hook.
 *
 * **Ordering is registration order** (§5.7's first open question, settled here). `buildRequest` is
 * a pipeline - each hook sees the previous one's output - and `aroundTool` nests outward-in, so
 * the first component registered is the outermost wrapper. No priority numbers: whoever wires the
 * components up knows the order it wants, and an explicit wiring order is easier to reason about
 * than a set of magic numbers that have to be kept globally consistent. The one real consequence
 * is that the wiring site is making a decision and should say so.
 */
export class CoreRegistry {
  private readonly components: CoreComponent[] = [];
  private readonly entryObservers: CoreComponent[] = [];
  private readonly requestHooks: CoreComponent[] = [];
  private readonly toolHooks: CoreComponent[] = [];
  private readonly noteHooks: CoreComponent[] = [];

  register(component: CoreComponent): void {
    this.components.push(component);
    if (component.onEntry) this.entryObservers.push(component);
    if (component.buildRequest) this.requestHooks.push(component);
    if (component.aroundTool) this.toolHooks.push(component);
    if (component.turnNote) this.noteHooks.push(component);
  }

  /** Each note-giving component's current note, by component name. A throwing one is skipped. */
  turnNotes(turn: { message: string; info?: (text: string) => void }, warn: SeamWarning): Array<{ name: string; text: string }> {
    const out: Array<{ name: string; text: string }> = [];
    for (const component of this.noteHooks) {
      try {
        const text = component.turnNote?.(turn);
        if (text) out.push({ name: component.name, text });
      } catch (error) {
        warn(`Core component "${component.name}" failed to give its note: ${describe(error)}`);
      }
    }
    return out;
  }

  /** Registered components, in registration order - for `/context`-style introspection. */
  get names(): readonly string[] {
    return this.components.map((c) => c.name);
  }

  /** Whether any of the three hooks has a subscriber, so callers can skip the work entirely. */
  hasEntryObservers(): boolean {
    return this.entryObservers.length > 0;
  }

  hasRequestHooks(): boolean {
    return this.requestHooks.length > 0;
  }

  hasToolHooks(): boolean {
    return this.toolHooks.length > 0;
  }

  /**
   * Fans an appended entry out to every observer.
   *
   * **A throwing observer is caught**, unlike `RunOptions.onEntry`'s own unguarded call. The
   * difference is deliberate: `onEntry` has exactly one caller and losing it means losing session
   * persistence, so failing loudly is right there. Here there are several independent observers,
   * and one of them failing must not stop the others or kill the turn - an observer is by
   * definition side-effect-only, so a dropped notification is strictly less bad than a dead turn.
   * Its own durability is its own problem.
   */
  notifyEntry(entry: ContextEntry, warn: SeamWarning): void {
    for (const component of this.entryObservers) {
      try {
        component.onEntry?.(entry);
      } catch (error) {
        warn(`Core component "${component.name}" failed to record an entry: ${describe(error)}`);
      }
    }
  }

  /**
   * Runs the `buildRequest` pipeline and returns the entries to project onto the wire.
   *
   * **A throwing or malformed hook is caught and skipped**, falling back to the pipeline value as
   * it stood before that hook. Safe precisely because this hook is a projection: the value before
   * it is always a legitimate request, so degrading costs that component's contribution and
   * nothing else. The alternative - letting it through - would mean a bug in a retrieval component
   * takes down every turn in the session, which is the same reasoning `src/mcp/` uses for a dead
   * server costing only its own tools.
   *
   * A hook returning a non-array is treated as a failure rather than coerced, because the
   * plausible way to get one is an `async` hook whose author forgot to return.
   */
  async buildEntries(build: RequestBuild, warn: SeamWarning): Promise<readonly ContextEntry[]> {
    let entries = build.entries;
    for (const component of this.requestHooks) {
      try {
        const next = await component.buildRequest?.({ ...build, entries });
        if (!Array.isArray(next)) {
          warn(`Core component "${component.name}" returned no entry list; ignoring it this turn.`);
          continue;
        }
        entries = next;
      } catch (error) {
        warn(`Core component "${component.name}" failed to build the request: ${describe(error)}`);
      }
    }
    return entries;
  }

  /**
   * Runs the `aroundTool` chain around `execute`.
   *
   * **A throwing hook is NOT caught here**, which is the one place this class lets an error
   * through, so the reason is worth stating: there is no safe recovery. Falling back to running
   * the tool would risk executing it twice - a hook may well have called `next()` before throwing -
   * and for a mutating tool that is a real-world side effect, not a wasted cycle. So a failing
   * hook surfaces exactly the way a failing tool already does today (`tool.execute` is likewise
   * unguarded at its call site), which is also the behaviour least likely to surprise.
   */
  runTool(call: ToolCallContext, execute: () => Promise<string>): Promise<string> {
    // Built inner-first so that the FIRST registered component ends up outermost, matching the
    // ordering rule on this class.
    let next = execute;
    for (const component of [...this.toolHooks].reverse()) {
      const inner = next;
      next = () => component.aroundTool!(call, inner);
    }
    return next();
  }
}
