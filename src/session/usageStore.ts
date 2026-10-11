import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * This project's lifetime token count, and the current session's share of it, for the footer's
 * token line and `/context`. Prompt and completion are kept apart, because they are not comparable
 * quantities: a measured 8h run sent 18.6M prompt tokens and generated 1.3M, so a single sum is
 * 94% prefill and says almost nothing about how much the model actually produced.
 *
 * Numbers that cannot come from `AgentLoop` alone. `loop.getUsage()` counts what THIS PROCESS has
 * spent, and a process here is short-lived: o4c reloads itself into a fresh process after most
 * turns (`reloadAfterTurn`, see App.tsx) so the screen can be repainted from saved history. A naive
 * "session total" would therefore reset to zero every turn or two, and a project total would never
 * exist at all. So both are carried on disk, and this process's own spend is added on top.
 *
 * The same reload is why the session's ACTIVE TIME lives here too (0002 item 7): the footer clock
 * used to count from process start, so it restarted every turn. It is wall time with the app open
 * on this session, summed across processes - not time the model spent working, and not time since
 * the session was created, which would count the hours a resumed session sat closed.
 *
 * Project-scoped and nothing else: no global fallback, same reasoning as `plansDirFor`. A count
 * pooled across unrelated directories would answer no question anyone asks.
 *
 * Writes are synchronous, by necessity rather than preference: the save has to happen on the way
 * out, and `process.on('exit')` is the only hook that catches every exit path this app has - it
 * allows no asynchronous work, so an `await`ed write would simply never land.
 */

/**
 * On-disk shape version. A newer (unrecognised) version makes this store read-only rather than
 * overwriting a format it does not understand.
 *
 * v2 split the single `projectTokens` sum into prompt and completion. A v1 file is migrated by
 * attributing its sum to `input` - stated plainly because it is an approximation, not a recovered
 * split: v1 never recorded the two separately, and prompt tokens were 93.6% of the total in the
 * one long run that was measured. The alternative was silently zeroing someone's lifetime count.
 *
 * v3 added `activeMs` and `requests` to each session's record. A v2 file needs no migration - both
 * read as 0 and start counting from this launch. The version still had to move, because the
 * freeze-on-newer rule above is what stops a v2 binary from dropping the two new fields on its
 * next write; left at 2, an older build would silently discard them.
 */
export const USAGE_FILE_VERSION = 3;

/** How many sessions' subtotals to keep. Bounded so the file cannot grow without limit, but more
 * than one: concurrent o4c sessions in the same project are a supported case, and a single
 * `session` field would make them clobber each other's running total. */
export const MAX_TRACKED_SESSIONS = 32;

/** Prompt tokens sent and completion tokens generated, always carried as a pair. */
export interface TokenSpend {
  /** Prompt tokens sent to the provider. Rendered with an up arrow: it goes up to the server. */
  input: number;
  /** Completion tokens generated. Rendered with a down arrow: it comes back down. */
  output: number;
}

/** What one process has spent so far, as reported by `AgentLoop`. Active time is deliberately not
 * in here: the store measures that itself, from its own construction, because nothing else knows
 * when this process started. */
export interface ProcessSpend extends TokenSpend {
  /** Provider round-trips (`CumulativeUsage.requestCount`), for `/context`'s "Requests sent". */
  requests: number;
}

/** A session's stored counters: what it has spent, and how long it has been open. */
export interface SessionSpend extends ProcessSpend {
  /** Milliseconds with the app open on this session, summed across every process that ran it. */
  activeMs: number;
}

export interface UsageTotals {
  /** Everything this project has ever spent, across all sessions and processes. */
  project: TokenSpend;
  /** The session on screen, which survives the per-turn reload and `/resume`. */
  session: SessionSpend;
}

interface StoredUsage {
  version: number;
  project: TokenSpend;
  /** Session id -> that session's running counters. Insertion-ordered, oldest first. */
  sessions: Record<string, SessionSpend>;
}

function zero(): TokenSpend {
  return { input: 0, output: 0 };
}

function zeroSession(): SessionSpend {
  return { input: 0, output: 0, requests: 0, activeMs: 0 };
}

function emptyUsage(): StoredUsage {
  return { version: USAGE_FILE_VERSION, project: zero(), sessions: {} };
}

/** A non-negative finite number, or 0. Guards against a hand-edited or half-written file putting
 * `null`, a string or a NaN into a counter that then renders as `NaN` forever. */
function sane(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Accepts both shapes: a v2 `{input, output}` pair, or a v1 bare number (migrated to input). */
function saneSpend(value: unknown): TokenSpend {
  if (typeof value === 'number') return { input: sane(value), output: 0 };
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return { input: sane(obj.input), output: sane(obj.output) };
  }
  return zero();
}

/** As `saneSpend`, plus v3's two fields - absent in a v1/v2 file, which is not an error: they read
 * as 0 and start counting from this launch. */
function saneSessionSpend(value: unknown): SessionSpend {
  const tokens = saneSpend(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return { ...tokens, requests: sane(obj.requests), activeMs: sane(obj.activeMs) };
  }
  return { ...tokens, requests: 0, activeMs: 0 };
}

function parseUsage(text: string): StoredUsage {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const obj = raw as Record<string, unknown>;
  const sessions: Record<string, SessionSpend> = {};
  if (obj.sessions && typeof obj.sessions === 'object') {
    for (const [id, spend] of Object.entries(obj.sessions as Record<string, unknown>)) {
      sessions[id] = saneSessionSpend(spend);
    }
  }
  // `projectTokens` is v1's name for the sum; `project` is v2's pair. Reading both means a v1 file
  // keeps its lifetime figure instead of starting over.
  const project = obj.project !== undefined ? saneSpend(obj.project) : saneSpend(obj.projectTokens);
  return { version: sane(obj.version) || USAGE_FILE_VERSION, project, sessions };
}

/**
 * Reads the stored totals, reports what to display, and writes the new totals back on the way out.
 *
 * Never throws, from either direction. An unreadable or corrupt file starts the count from zero (a
 * display counter is not worth failing a launch over), and a failed write is swallowed (losing one
 * session's count is bad; failing to exit is worse).
 */
export class UsageStore {
  /** What was on disk at startup - the display baseline this process adds its own spend to. */
  private projectBaseline = zero();
  private sessionBaseline = zeroSession();
  private sessionId: string | undefined;
  /** When this process started counting time. Taken at construction rather than in `load()` so the
   * two cannot drift apart if a caller ever loads late. */
  private readonly startedAt: number;
  /** Set when the file is a version we do not understand: read nothing, write nothing. */
  private frozen = false;
  /** `flush()` is called explicitly on the way out AND from `process.on('exit')`, which can both
   * fire for one exit; the second must not double-count this process's spend. */
  private flushed = false;

  /**
   * @param file             where to store the totals (`usageFileFor(projectRoot)`)
   * @param spentThisProcess reads the provider-reported tokens/requests this process has used
   * @param now              injectable clock, so a test can advance time without waiting for it
   */
  constructor(
    private readonly file: string,
    private readonly spentThisProcess: () => ProcessSpend,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Reads the file. `sessionId` is the session being resumed, if any - on a per-turn reload or an
   * explicit `/resume` that is how the session's running total is picked up again. A session id
   * that is not in the file (a brand new session) correctly starts at zero. */
  load(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    let stored: StoredUsage;
    try {
      stored = parseUsage(readFileSync(this.file, 'utf-8'));
    } catch {
      return; // No file yet, or unreadable - start from zero and write one on the way out.
    }
    if (stored.version > USAGE_FILE_VERSION) {
      this.frozen = true;
      return;
    }
    this.projectBaseline = stored.project;
    this.sessionBaseline = (sessionId ? stored.sessions[sessionId] : undefined) ?? zeroSession();
  }

  /** Called when the session acquires an id mid-run (a new session gets one at its first save). */
  setSessionId(id: string | undefined): void {
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
  }

  /** How long this process has been counting. Never negative, even if the clock steps backwards -
   * a real risk on a wall clock, which NTP and DST both move. */
  private elapsed(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  /** What the footer and `/context` should show right now. Cheap and allocation-light - it is read
   * on render. */
  totals(): UsageTotals {
    const spent = this.spentThisProcess();
    const input = Math.max(0, spent.input);
    const output = Math.max(0, spent.output);
    const requests = Math.max(0, spent.requests);
    return {
      project: {
        input: this.projectBaseline.input + input,
        output: this.projectBaseline.output + output,
      },
      session: {
        input: this.sessionBaseline.input + input,
        output: this.sessionBaseline.output + output,
        requests: this.sessionBaseline.requests + requests,
        activeMs: this.sessionBaseline.activeMs + this.elapsed(),
      },
    };
  }

  /**
   * Writes the totals back. Idempotent: only the first call for a given process counts, so the
   * explicit call on the way out and the `process.on('exit')` backstop cannot double-count.
   *
   * Re-reads the file first and adds this process's spend to whatever is there NOW, rather than to
   * the startup baseline. That is what makes two concurrent o4c sessions in one project additive
   * instead of last-writer-wins.
   */
  flush(): void {
    if (this.flushed || this.frozen) return;
    this.flushed = true;
    const spent = this.spentThisProcess();
    const input = Math.max(0, spent.input);
    const output = Math.max(0, spent.output);
    const requests = Math.max(0, spent.requests);
    const activeMs = this.elapsed();
    // Nothing spent, and no session to attribute time to - no reason to touch the file at all.
    // Time alone IS worth a write (recording it is the whole point), but only once there is a
    // session id to file it under: a process that exits before the first turn - a piped-stdin run
    // that bails out of the REPL, say - has nowhere to put its seconds and should not create a
    // usage file just to say so.
    if (input === 0 && output === 0 && !this.sessionId) return;
    try {
      let current: StoredUsage;
      try {
        current = parseUsage(readFileSync(this.file, 'utf-8'));
      } catch {
        current = emptyUsage();
      }
      if (current.version > USAGE_FILE_VERSION) return; // Appeared since load - leave it alone.
      current.project = {
        input: current.project.input + input,
        output: current.project.output + output,
      };
      if (this.sessionId) {
        const base = current.sessions[this.sessionId] ?? this.sessionBaseline;
        const total = {
          input: base.input + input,
          output: base.output + output,
          requests: base.requests + requests,
          activeMs: base.activeMs + activeMs,
        };
        // Delete before setting so the touched session moves to the end, making the key order a
        // real recency order for the trim below.
        delete current.sessions[this.sessionId];
        current.sessions[this.sessionId] = total;
        const ids = Object.keys(current.sessions);
        for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_SESSIONS))) {
          delete current.sessions[id];
        }
      }
      current.version = USAGE_FILE_VERSION;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
    } catch {
      // A display counter is never worth failing an exit over.
    }
  }
}
