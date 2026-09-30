import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../ui/App.js';
import { AgentLoop } from '../agent/loop.js';
import { MockProvider } from '../providers/mock.js';
import { defaultTools } from '../tools/index.js';
import { SessionStore } from '../session/sessionStore.js';
import { RunLogger } from '../session/runLog.js';
import { ConfigStore } from '../session/configStore.js';
import { userInputEntry, aiResponseEntry, toWireMessages } from '../agent/contextEntry.js';
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../providers/types.js';

// Simulates a turn that never comes back (a hung/runaway local-model generation) so tests can
// verify /exit isn't stuck waiting behind it in the FIFO queue.
class HangingProvider implements LLMProvider {
  readonly name = 'hanging';
  complete(_request: CompletionRequest): Promise<CompletionResponse> {
    return new Promise(() => {});
  }
}

// Simulates a turn that hangs until cancelled - unlike HangingProvider (which never settles at
// all, for the /exit-bypasses-the-queue test), this one respects the signal AgentLoop passes
// through from App.tsx's Escape handler, the same way a real fetch/SDK call would reject once
// aborted. Lets a test verify the actual UI wiring (Escape -> abort -> restored prompt), not just
// AgentLoop's own rollback logic (already covered directly in loop.test.ts).
class AbortAwareHangingProvider implements LLMProvider {
  readonly name = 'abort-aware-hanging';
  // Observable from a test without needing to catch the rejection itself - lets a test confirm
  // the signal actually fired (e.g. /clear mid-turn) without also having to handle/await the
  // rejected promise this class's own call site never awaits either.
  public aborted = false;
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return new Promise((_, reject) => {
      request.signal?.addEventListener('abort', () => {
        this.aborted = true;
        reject(new Error('simulated in-flight cancellation'));
      });
    });
  }
}

// Ignores any abort signal entirely and just resolves normally after a fixed delay - simulates
// the exact case Escape/Ctrl+C's abort attempt can't help with (whatever's stuck never actually
// checks the signal), used to prove the turnGenerationRef guard: an abandoned call settling late
// must never clobber a newer generation's visible state.
class DelayedAnswerProvider implements LLMProvider {
  readonly name = 'delayed-test';
  constructor(private delayMs: number) {}
  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { content: 'stale answer, arrived too late', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Simulates a "explore the codebase"-style turn that calls a tool many times in a row, so tests
// can verify the display collapses past the cap instead of flooding the screen (the actual bug
// the user hit and diagnosed themselves).
class ManyToolCallsProvider implements LLMProvider {
  readonly name = 'many-tool-calls';
  private calls = 0;

  constructor(private totalCalls: number) {}

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    if (this.calls < this.totalCalls) {
      this.calls += 1;
      return {
        content: '',
        toolCalls: [
          { id: `call-${this.calls}`, name: 'read_file', input: { path: `nonexistent-${this.calls}.txt` } },
        ],
        stopReason: 'tool_use',
      };
    }
    return { content: 'done scanning', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Calls write_file once (at a caller-chosen path) then ends the turn - lets mode-system tests
// verify real end-to-end behavior (file created or not) rather than just checking UI text.
class WriteFileProvider implements LLMProvider {
  readonly name = 'write-file-test';
  private called = false;
  constructor(private targetPath: string) {}
  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.called) {
      this.called = true;
      return {
        content: '',
        toolCalls: [{ id: 'w1', name: 'write_file', input: { path: this.targetPath, content: 'hello' } }],
        stopReason: 'tool_use',
      };
    }
    return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Calls write_file twice, sequentially, across two separate provider responses (not two calls in
// one response) - lets a test switch mode in the gap between them, simulating a real mid-turn
// mode change during a long multi-iteration turn.
class TwoWriteFileProvider implements LLMProvider {
  readonly name = 'two-write-file-test';
  private step = 0;
  constructor(private path1: string, private path2: string) {}
  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    if (this.step === 0) {
      this.step = 1;
      return {
        content: '',
        toolCalls: [{ id: 'w1', name: 'write_file', input: { path: this.path1, content: 'first' } }],
        stopReason: 'tool_use',
      };
    }
    if (this.step === 1) {
      this.step = 2;
      return {
        content: '',
        toolCalls: [{ id: 'w2', name: 'write_file', input: { path: this.path2, content: 'second' } }],
        stopReason: 'tool_use',
      };
    }
    return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Captures the systemPrompt actually sent on the most recent request, then ends the turn - lets a
// test verify modeInstruction really reaches the provider through App.tsx's real wiring, not just
// AgentLoop's own unit tests (loop.test.ts already covers the string-concatenation logic itself).
class RecordingProvider implements LLMProvider {
  readonly name = 'recording';
  lastSystemPrompt = '';
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.lastSystemPrompt = request.systemPrompt;
    return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Returns a <think> block plus a tool call first, then the final answer (no think) on the second
// response - the real await on tool execution in between (loop.ts) gives React/Ink an actual
// yield point to commit the intermediate "[think] .../[tool] ..." live frame before the turn
// finishes, unlike a single-response think+answer turn where both onEvent calls fire
// back-to-back with nothing async between them to force a separate render commit.
class ThinkingWithToolProvider implements LLMProvider {
  readonly name = 'thinking-tool-test';
  private step = 0;
  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    if (this.step === 0) {
      this.step = 1;
      return {
        content: '<think>let me check the file first</think>',
        toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'x' } }],
        stopReason: 'tool_use',
      };
    }
    return { content: 'The answer is 4.', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Streams a real 'think' chunk via onToken, then pauses (until the test calls resume()) before
// streaming the real answer and resolving - lets a test inspect the LIVE frame mid-turn, the
// actual behavior being tested (a live "[think]" label the instant reasoning starts streaming,
// not just a post-hoc one after the turn completes).
class StreamingThinkProvider implements LLMProvider {
  readonly name = 'streaming-think-test';
  private release!: () => void;
  private paused: Promise<void>;
  constructor() {
    this.paused = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  resume(): void {
    this.release();
  }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    request.onToken?.('reasoning about it', 'think');
    await this.paused;
    request.onToken?.('the final answer', 'text');
    return { content: 'the final answer', toolCalls: [], stopReason: 'end_turn' };
  }
}

// Fires many single-character onToken calls in one tight, synchronous burst (no awaits between
// them) before resolving - the most demanding case for App.tsx's delta-buffering throttle
// (deltaBufferRef/flushDeltaBuffer), since every one of these arrives within the same handful of
// flush windows rather than spread out like a real model's own token pacing would be.
class RapidChunkProvider implements LLMProvider {
  readonly name = 'rapid-chunk-test';
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const full = 'the quick brown fox jumps over the lazy dog';
    for (const ch of full) request.onToken?.(ch, 'text');
    return { content: full, toolCalls: [], stopReason: 'end_turn' };
  }
}

// Calls run_shell once with a harmless command, then ends the turn.
class RunShellProvider implements LLMProvider {
  readonly name = 'run-shell-test';
  private called = false;
  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.called) {
      this.called = true;
      return {
        content: '',
        toolCalls: [{ id: 's1', name: 'run_shell', input: { command: 'echo hi' } }],
        stopReason: 'tool_use',
      };
    }
    return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
  }
}

const ENTER = String.fromCharCode(13);
const ESCAPE = String.fromCharCode(27);
const UP = String.fromCharCode(27) + '[A';
const DOWN = String.fromCharCode(27) + '[B';
const TAB = String.fromCharCode(9);

// Default bumped from 10ms to 30ms - React 19 + Ink 7's internal scheduling (useEffectEvent,
// discreteUpdates) takes measurably longer to settle a keypress into a committed state update
// than the previous stack did. Confirmed empirically (SelectList): 10ms was flaky, 20ms was
// reliable in isolation; 30ms gives margin for real test-runner contention. Explicit tick(N)
// call sites below with N<30 (e.g. between a DOWN and the ENTER that follows it) are bumped to
// match for the same reason - they hit the identical settle-time issue.
function tick(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submit(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
  stdin.write(ENTER);
  await tick();
}

async function type(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

// InputBox reports its live value to App via a onChange effect, not synchronously with the
// keystroke - under tsx's on-the-fly transpilation that extra render cycle can occasionally take
// longer to settle than any fixed delay reliably covers. Polling instead of sleeping a fixed
// amount avoids that flakiness without just guessing at a bigger number.
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition was not met within the timeout');
    }
    await tick(100);
  }
}

// Ink's Static component commits content as a one-time append rather than redrawing it in every
// subsequent frame - the mock stdout's lastFrame() can legitimately miss earlier-committed static
// blocks if a later live-only re-render happened after. Checking across every captured frame is
// the robust way to assert "this text appeared at some point," matching what Static is actually
// for (permanent scrollback), not "this text is in the current frame."
function anyFrameIncludes(frames: string[], text: string): boolean {
  return frames.some((f) => f.includes(text));
}

// Every render() left mounted for the rest of the process, across every test in this file - this
// was harmless under the previous Ink 5/React 18 stack (each test's fake stdin/stdout are their
// own separate objects) but causes real cross-test interference under Ink 7/React 19 (observed:
// otherwise-correct DOWN/ENTER interactions in a later test failing only when the full suite
// runs, never in isolation - dozens of accumulated live instances is the actual variable). Track
// every instance `setup()` creates and unmount them all after each test via node:test's
// `afterEach`, rather than touching every individual test to do it manually.
let liveInstances: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const instance of liveInstances) instance.unmount();
  liveInstances = [];
});

async function setup(opts: {
  dir: string;
  provider?: LLMProvider;
  // As if this process had been launched via `--resume <id>` (a /resume restart handoff) -
  // see the "launched with an initial session" test below for what this actually covers.
  initialSession?: { id: string; title: string; messages: Message[] };
  // Only relevant to Plan-Write mode tests - scopes its write_file exception to
  // `<projectRoot>/.o4c/plans/`. Omitted (as every non-Plan-Write test does) means Plan-Write
  // behaves exactly like plain Plan (see modePolicy.ts's plansDirFor(undefined) fallback).
  projectRoot?: string;
  // Test isolation for /config-global-highlightcolor - see AppProps.configGlobalDir's own doc
  // comment. Omitted means the real ~/.o4c, exactly like every other test that never touches it.
  configGlobalDir?: string;
}) {
  const store = new SessionStore(opts.dir);
  const runLogger = new RunLogger(join(opts.dir, 'logs'));
  const fullContextLogger = new RunLogger(join(opts.dir, 'logs'), 'FULLCONTEXT');
  const loop = new AgentLoop(opts.provider ?? new MockProvider(), defaultTools, 'test system prompt');
  // /clear and /resume now hand off to a brand-new process instead of resetting state
  // in-place (see AppProps.restart's doc comment) - nothing to actually spawn in a test, so this
  // just records what App asked for.
  const restartCalls: Array<string | undefined> = [];
  const restart = (resumeId?: string) => {
    restartCalls.push(resumeId);
  };
  const instance = render(
    React.createElement(App, {
      loop,
      sessionStore: store,
      runLogger,
      fullContextLogger,
      initialSession: opts.initialSession,
      restart,
      projectRoot: opts.projectRoot,
      model: 'test-model',
      provider: 'mock',
      baseUrl: '',
      initialHighlightColor: '#FFBF00',
      configGlobalDir: opts.configGlobalDir,
    }),
  );
  liveInstances.push(instance);
  await tick();
  return { ...instance, loop, store, runLogger, fullContextLogger, restartCalls };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-app-test-'));
  try {
    await fn(dir);
  } finally {
    // maxRetries/retryDelay (Node's own option, not hand-rolled): App.tsx's run-log write is
    // intentionally fire-and-forget (`void runLogger.log(...)`), so a test can reach this
    // cleanup before that last write has actually landed on disk - deleting the directory out
    // from under an in-flight Windows file handle throws ENOTEMPTY, not ENOENT, so `force`
    // alone doesn't cover it.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('startup splash header shows the word-mark, provider/model, and starting mode', async () => {
  await withTempDir(async (dir) => {
    const { lastFrame } = await setup({ dir });
    const frame = lastFrame() ?? '';

    assert.match(frame, /█████/); // the word-mark itself
    assert.match(frame, /mock · test-model/); // no baseUrl segment - provider isn't 'local'
    assert.match(frame, /Mode: Manual/); // AgentLoop/App always start in Manual mode
    assert.match(frame, /Type your request, or \/ to see available commands\./);
  });
});

test('/exit bypasses the FIFO queue even while a turn is stuck processing, instead of sitting queued behind it', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir, provider: new HangingProvider() });

    // Kick off a turn that will never resolve, so isProcessing stays true indefinitely.
    await submit(stdin, 'this will hang forever');
    await tick(50);

    await submit(stdin, '/exit');
    await tick(50);

    // Before the fix, this would have been queued and shown as "Queued #1: /exit" until the
    // hung turn eventually finished - which for a genuinely hung request is never.
    assert.equal(anyFrameIncludes(frames, 'Queued #1: /exit'), false);
  });
});

test('/clear bypasses the FIFO queue even while a turn is busy, instead of firing silently once it finishes', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, restartCalls } = await setup({ dir, provider: new HangingProvider() });

    // Kick off a turn that will never resolve, so isProcessing stays true indefinitely.
    await submit(stdin, 'this will hang forever');
    await tick(50);

    await submit(stdin, '/clear');
    await tick(50);

    // Before the fix, this queued silently (shown only as "Queued #1: /clear") and only fired -
    // unannounced, no further keypress - once the hung turn eventually finished (never, here).
    // The real bug this reproduces: a /clear typed while busy appeared to reset the screen with
    // no user action at all, because the actual trigger and its effect were separated in time.
    assert.equal(anyFrameIncludes(frames, 'Queued #1: /clear'), false);
    assert.deepEqual(restartCalls, [undefined]);
  });
});

test('/clear mid-turn aborts the in-flight turn first, not just bypassing the queue', async () => {
  await withTempDir(async (dir) => {
    const provider = new AbortAwareHangingProvider();
    const { stdin, restartCalls } = await setup({ dir, provider });

    await submit(stdin, 'this will hang until aborted');
    await tick(50);
    assert.equal(provider.aborted, false);

    await submit(stdin, '/clear');
    await tick(50);

    // Real reported symptom this prevents: without aborting first, the busy turn's still-arriving
    // delta/think events kept updating the live status bar's token count for however long it took
    // to settle on its own - all while this process was already mid-exit - so /clear during a
    // long think appeared to leave a large, growing count on screen instead of resetting to 0.
    assert.equal(provider.aborted, true);
    assert.deepEqual(restartCalls, [undefined]);
  });
});

test('Escape while thinking cancels the turn and restores its prompt to the input box', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir, provider: new AbortAwareHangingProvider() });

    await submit(stdin, 'this will hang until cancelled');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Thinking...'));

    stdin.write(ESCAPE);
    await waitFor(() => anyFrameIncludes(frames, 'Cancelled'));

    const last = frames[frames.length - 1] ?? '';
    assert.equal(last.includes('Thinking...'), false);
    assert.ok(last.includes('this will hang until cancelled'));

    // Not just cosmetic text left sitting in the box - confirm the app is genuinely back to a
    // normal, resumable state by actually resubmitting it (Enter, no retyping needed) and
    // seeing a fresh turn start.
    const framesBeforeResubmit = frames.length;
    stdin.write(ENTER);
    await tick(50);
    assert.ok(frames.slice(framesBeforeResubmit).some((f) => f.includes('Thinking...')));
  });
});

test('a turn with many tool calls collapses the display past the cap, but logs every event in full', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, runLogger } = await setup({ dir, provider: new ManyToolCallsProvider(15) });

    await submit(stdin, 'explore the codebase');
    // Polling, not a fixed delay - 15 rounds of tool_call/tool_result each trigger their own
    // render, and React 19 + Ink 7 settles each one measurably slower than the previous stack
    // did under node:test, so a fixed guess isn't reliable for a turn this long.
    await waitFor(() => anyFrameIncludes(frames, 'done scanning'));

    assert.ok(anyFrameIncludes(frames, '[scan] '));
    assert.ok(anyFrameIncludes(frames, 'collapsed'));
    assert.ok(anyFrameIncludes(frames, 'done scanning'));

    const logPath = runLogger.getFilePath();
    assert.ok(logPath);
    // Poll for all 32 lines to actually be on disk, not just read once - runLogger.log() is
    // fire-and-forget (App.tsx never awaits it), so the UI showing "done scanning" only means
    // the last event's *render* committed, not that its log write has necessarily landed yet.
    let lines: string[] = [];
    await waitFor(async () => {
      const raw = await readFile(logPath as string, 'utf-8');
      lines = raw.trim().split('\n');
      return lines.length >= 32;
    });
    // 15 rounds x (tool_call + tool_result) = 30, plus 1 final "text" event carrying the
    // answer = 31 raw AgentEvents, all of them logged regardless of what got collapsed on
    // screen - the cap only affects what's displayed, never what's logged. Plus 1 more: the
    // [scan] collapse itself is now also a distinct, findable log entry (not just implicit in
    // the raw event count), logged once per turn, not once per collapsed event.
    assert.equal(lines.length, 32);
    assert.ok(lines.every((l) => JSON.parse(l).ts));

    const parsed = lines.map((l) => JSON.parse(l));
    const scanEntry = parsed.find((e) => e.tag === 'scan-collapse');
    assert.ok(scanEntry);
    assert.equal(scanEntry.type, 'system');
    assert.equal(scanEntry.sub_type, 'info');
    // 15 rounds x 2 events (tool_call + tool_result) = 30 tool events total, cap is 10, so 20 over.
    assert.equal(scanEntry.collapsedCount, 20);
    assert.equal(scanEntry.toolEventTotal, 30);
  });
});

test('a real turn writes a separate <timestamp>.FULLCONTEXT.jsonl with the full request/response and tool events', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, runLogger, fullContextLogger } = await setup({ dir });

    await submit(stdin, 'read something please');
    await waitFor(() => anyFrameIncludes(frames, 'canned mock response'));

    // Both loggers' own ensureFile() is itself async (an awaited mkdir before filePath is set) -
    // fire-and-forget from App.tsx same as every other runLogger.log() call, so the file/path
    // existing is not guaranteed the instant the render committed. Poll for both paths first.
    let plainPath: string | undefined;
    let fullPath: string | undefined;
    await waitFor(() => {
      plainPath = runLogger.getFilePath();
      fullPath = fullContextLogger.getFilePath();
      return plainPath !== undefined && fullPath !== undefined;
    });
    // Same directory/timestamp convention, distinct file - never collides with runLogger's own.
    assert.notEqual(fullPath, plainPath);
    assert.ok((fullPath as string).endsWith('.FULLCONTEXT.jsonl'));

    let lines: string[] = [];
    await waitFor(async () => {
      const raw = await readFile(fullPath as string, 'utf-8');
      lines = raw.trim().split('\n').filter(Boolean);
      return lines.some((l) => JSON.parse(l).type === 'provider_call');
    });
    const parsed = lines.map((l) => JSON.parse(l));

    const providerCalls = parsed.filter((e) => e.type === 'provider_call');
    assert.ok(providerCalls.length > 0);
    // The actual wire-level payload - request messages/tools and the full raw response, not just
    // a reference to it.
    assert.ok(Array.isArray(providerCalls[0].request.messages));
    assert.ok(Array.isArray(providerCalls[0].request.tools));
    assert.ok('content' in providerCalls[0].response);
    assert.ok('stopReason' in providerCalls[0].response);

    // Tool calls/results also land here (MockProvider always calls a tool on its first round) -
    // not just provider round-trips, matching "everything" rather than half the picture.
    assert.ok(parsed.some((e) => e.event?.type === 'tool_call'));
    assert.ok(parsed.some((e) => e.event?.type === 'tool_result'));
  });
});

test('a <think> block shows live as [think], is logged as its own event, and never leaks into the final answer', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop, runLogger } = await setup({ dir, provider: new ThinkingWithToolProvider() });

    await submit(stdin, 'what is 2+2?');
    await waitFor(() => anyFrameIncludes(frames, 'The answer is 4.'));

    assert.ok(anyFrameIncludes(frames, '[think] let me check the file first'));
    // The final answer committed to permanent scrollback must be the clean text only - no raw
    // <think> tags leaking through anywhere.
    assert.ok(anyFrameIncludes(frames, 'The answer is 4.'));
    assert.ok(!anyFrameIncludes(frames, '<think>'));

    // Only type/sub_type checked for the tool-call/result pair - their exact content (the
    // read_file error text for a nonexistent path) isn't what this test is about. The 3rd entry
    // is the empty-content `response` AgentLoop.run() still logs for the first (tool-use)
    // provider call, same as any tool-call-only turn - see contextEntry.test.ts's own coverage
    // of that.
    assert.deepEqual(
      loop.getEntries().map((e) => ({ type: e.type, sub_type: e.sub_type })),
      [
        { type: 'user', sub_type: 'input' },
        { type: 'ai', sub_type: 'think' },
        { type: 'ai', sub_type: 'response' },
        { type: 'ai', sub_type: 'toolcall' },
        { type: 'ai', sub_type: 'toolcallresponse' },
        { type: 'ai', sub_type: 'response' },
      ],
    );
    assert.equal(loop.getEntries()[1].content, 'let me check the file first');
    assert.equal(loop.getEntries()[5].content, 'The answer is 4.');

    const logPath = runLogger.getFilePath();
    assert.ok(logPath);
    let lines: string[] = [];
    await waitFor(async () => {
      lines = (await readFile(logPath as string, 'utf-8')).trim().split('\n');
      return lines.length >= 4;
    });
    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.some((e) => e.type === 'think' && e.text === 'let me check the file first'));
    assert.ok(events.some((e) => e.type === 'text' && e.text === 'The answer is 4.'));
  });
});

test('a live-streaming think chunk shows "[think] " the instant reasoning starts, before the turn completes', async () => {
  await withTempDir(async (dir) => {
    const provider = new StreamingThinkProvider();
    const { stdin, lastFrame } = await setup({ dir, provider });

    await submit(stdin, 'what is 2+2?');
    // The turn is deliberately still in flight here (provider is paused mid-stream) - this is the
    // real behavior being fixed: previously nothing distinguished a live reasoning chunk from a
    // live answer chunk, so this label never appeared until after the fact (see the ThinkingWithToolProvider
    // test above, which only ever exercises the non-streamed fallback path).
    await waitFor(() => (lastFrame() ?? '').includes('[think] reasoning about it'));

    // The real answer hasn't streamed in yet - it's still paused - so it must not appear yet.
    assert.equal((lastFrame() ?? '').includes('the final answer'), false);

    provider.resume();
    await waitFor(() => (lastFrame() ?? '').includes('the final answer'));
    // Once the answer starts, it's on its own line, not run on from the reasoning text.
    assert.equal((lastFrame() ?? '').includes('reasoning about itthe final answer'), false);
  });
});

test('many rapid streamed chunks in one response coalesce correctly, not dropped or corrupted', async () => {
  // Regression test for the real O(n²) render-cost bug found via direct reproduction, 2026-09-30:
  // dispatching a full React re-render (plus a whole-frame terminal repaint) for every single raw
  // streamed chunk made one very long response take minutes of pure CPU time, starving the
  // garbage collector and crashing the process outright (a real captured
  // "JavaScript heap out of memory" - not a display bug at all, despite reading like one). Fixed
  // by buffering deltas and flushing at a bounded rate instead of once per chunk - this proves the
  // buffering itself doesn't drop or corrupt content under the most demanding case (many chunks in
  // one tight synchronous burst, not spread out like real token pacing).
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir, provider: new RapidChunkProvider() });
    await submit(stdin, 'go');
    await waitFor(() => (lastFrame() ?? '').includes('the quick brown fox jumps over the lazy dog'));
  });
});

test('typing "/" opens a command palette listing every command, alphabetically ascending', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await type(stdin, '/');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, '/clear'));
    assert.ok(anyFrameIncludes(frames, '/resume'));
    // /clear must appear before /resume in the same frame - alphabetical order.
    const frame = frames.find((f) => f.includes('/clear') && f.includes('/resume'));
    assert.ok(frame);
    assert.ok(frame.indexOf('/clear') < frame.indexOf('/resume'));
  });
});

test('the command palette narrows as more is typed', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    // Typed one character at a time, so the palette necessarily passes through its full,
    // unfiltered state right after "/" before "c" narrows it - only the CURRENT frame reflects
    // the final, narrowed state; the cumulative frame log would still contain that wider state.
    // InputBox reports its live value to App via an onChange effect (not synchronously), so
    // narrowing the palette costs one extra render cycle after the keystroke - waitFor polls
    // until that's actually settled instead of gambling on a fixed delay.
    await type(stdin, '/c');
    // Not "/mode" - App.tsx's always-visible "Mode: Manual (/mode or Tab to change)" status line
    // contains that substring regardless of the palette, so it would never disappear. "/set" has
    // no such collision anywhere else on screen.
    await waitFor(() => !(lastFrame() ?? '').includes('/set'));

    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('/clear'));
    assert.ok(frame.includes('/context'));
    assert.equal(frame.includes('/set'), false);
    // A bare substring check for "/resume" would false-positive here - /clear's own
    // description literally says "...still resumable via /resume)." Check for the actual
    // list-entry pattern (name immediately followed by the palette's " — " separator) instead.
    assert.equal(frame.includes('/resume —'), false);
  });
});

test('Enter in the command palette selects and submits the highlighted command, clearing the input', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, restartCalls } = await setup({ dir });

    // "/cl" uniquely matches /clear (not /context/ctx) - Enter should submit it directly.
    await type(stdin, '/cl');
    await waitFor(() => anyFrameIncludes(frames, '/clear'));
    stdin.write(ENTER);
    await tick(50);

    // /clear hands off to a restart (no resumeId) rather than resetting state in-place.
    assert.deepEqual(restartCalls, [undefined]);
  });
});

test('the command palette respects arrow-key navigation instead of falling through to input history', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, lastFrame } = await setup({ dir });

    // /c matches /clear, /config, /context, alphabetically (#6 added /config) - two Downs move
    // off /clear, past /config, onto /context.
    await type(stdin, '/c');
    await waitFor(() => anyFrameIncludes(frames, '/context'));
    // The palette's content becoming visible and its own useInput actually finishing
    // subscription are two different moments (the same "effect registers asynchronously after
    // render" gap InputBox's own tests already account for) - a fixed buffer here, not another
    // waitFor, since there's no visible signal for "input-ready" to poll on.
    await tick(150);
    stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? '').includes('> /config'));
    stdin.write(DOWN);
    // Poll for the second DOWN to actually land (selection marker moved onto /context) rather
    // than a fixed delay before ENTER - React 19 + Ink 7's scheduling settles a keypress into a
    // committed state update measurably slower than the previous stack did under node:test
    // specifically, and by how much varies per interaction, so a fixed guess isn't reliable here.
    await waitFor(() => (lastFrame() ?? '').includes('> /context'));
    stdin.write(ENTER);
    await waitFor(() => anyFrameIncludes(frames, 'Session usage')); // /context's own output
  });
});

test('Escape dismisses the command palette without submitting, and typing again reopens it', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    await type(stdin, '/c');
    await waitFor(() => (lastFrame() ?? '').includes('/context'));
    stdin.write(ESCAPE);
    await waitFor(() => !(lastFrame() ?? '').includes('/context'));
    // Static-committed history is cumulative across frames, so a "did it ever appear" check
    // isn't the right tool for "is it showing right now" - only the current frame answers that.
    assert.equal(lastFrame()?.includes('/context'), false);

    await type(stdin, 'l');
    await waitFor(() => (lastFrame() ?? '').includes('/clear'));
    assert.ok(lastFrame()?.includes('/clear'));
  });
});

test('/debug no longer exists - treated as an unknown command', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/debug');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Unknown command: /debug'));
  });
});

test('an unrecognized slash command gives clear feedback instead of being sent to the model', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/nonexistent');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Unknown command: /nonexistent'));
  });
});

test('a real Unix-path-shaped message is NOT mistaken for a command', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/usr/local/bin/node --version');
    await tick(100);

    assert.equal(anyFrameIncludes(frames, 'Unknown command'), false);
    // It should have gone to the model instead - MockProvider's canned response text appears.
    assert.ok(anyFrameIncludes(frames, 'mock'));
    assert.ok(loop.getMessages().length > 0);
  });
});

test('/context shows a zero-usage breakdown before any real turn has run', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/context');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Session usage'));
    assert.ok(anyFrameIncludes(frames, 'Requests sent: 0'));
  });
});

test('/context reflects real usage after a turn has run', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, 'do something');
    await tick(100);
    await submit(stdin, '/ctx');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Requests sent: 2')); // MockProvider: tool call, then final
  });
});

test('/keyboardcommands shows the keybinding table without ever touching conversation history', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/keyboardcommands');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Ctrl+J'));
    assert.ok(anyFrameIncludes(frames, 'Kitty terminals only'));
    // Local/display-only, like /context - no loop.run() call means no LLM request and nothing
    // added to history, so this is never sent to the model or persisted as part of the session.
    assert.equal(loop.getMessages().length, 0);
    assert.equal(loop.getUsage().requestCount, 0);
  });
});

test('/keyboardcommands <os> shows that OS\'s notes, still without touching conversation history', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/keyboardcommands windows');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Windows keyboard notes'));
    assert.ok(anyFrameIncludes(frames, 'AltGr'));
    assert.equal(loop.getMessages().length, 0);
    assert.equal(loop.getUsage().requestCount, 0);
  });
});

test('/keyboardcommands <bogus> shows a usage error instead of guessing an OS', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/keyboardcommands nonsense');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Usage: /keyboardcommands [windows|mac|linux]'));
    assert.equal(loop.getMessages().length, 0);
    assert.equal(loop.getUsage().requestCount, 0);
  });
});

test('/help lists every command with its description, and logs itself under [info]', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop, runLogger } = await setup({ dir });

    await submit(stdin, '/help');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Available commands:'));
    assert.ok(anyFrameIncludes(frames, '/mode'));
    assert.ok(anyFrameIncludes(frames, '/keyboardcommands'));
    assert.ok(anyFrameIncludes(frames, 'Use /help-<command> for more detail'));
    assert.equal(loop.getMessages().length, 0);
    assert.equal(loop.getUsage().requestCount, 0);

    const logPath = runLogger.getFilePath();
    assert.ok(logPath);
    let lines: string[] = [];
    await waitFor(async () => {
      lines = (await readFile(logPath as string, 'utf-8')).trim().split('\n');
      return lines.length >= 1;
    });
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(parsed.some((e) => e.type === 'system' && e.sub_type === 'info' && e.command === '/help'));
  });
});

test('/help-mode explains what /mode does and breaks down all five modes', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/help-mode');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, '/mode —'));
    assert.ok(anyFrameIncludes(frames, 'Modes:'));
    assert.ok(anyFrameIncludes(frames, 'Manual —'));
    assert.ok(anyFrameIncludes(frames, 'Plan-Write —'));
    assert.equal(loop.getMessages().length, 0);
  });
});

test('/help-<hidden command> still works by exact name, e.g. /help-set-sessionname', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/help-set-sessionname');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, '/set-sessionname —'));
    assert.ok(anyFrameIncludes(frames, 'Rename the current session'));
  });
});

test('/help-<unknown> shows an error instead of a blank or crashed response', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/help-bogus');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'No such command: /bogus'));
    assert.ok(anyFrameIncludes(frames, 'Try /help for the full list'));
  });
});

test('a real turn autosaves the session, and /clear hands off to a restart with no resumeId', async () => {
  await withTempDir(async (dir) => {
    const { stdin, store, restartCalls } = await setup({ dir });

    await submit(stdin, 'first session message');

    // The autosave itself is a real async write to disk, after the turn finishes - a fixed tick
    // raced it under load (confirmed: this test failed asserting manifest length 0 !== 1 on a
    // slow run). Poll for the real manifest entry instead.
    await waitFor(async () => (await store.readManifest()).length === 1);
    const manifestAfterFirst = await store.readManifest();
    const firstId = manifestAfterFirst[0].id;

    await submit(stdin, '/clear');
    await tick(50);

    // No resumeId - the freshly spawned process starts blank, with a brand-new session id on its
    // next autosave, rather than overwriting this one.
    assert.deepEqual(restartCalls, [undefined]);
    // The pre-clear session must still be on disk and resumable.
    const manifestAfterClear = await store.readManifest();
    assert.ok(manifestAfterClear.some((m) => m.id === firstId));
  });
});

test('/resume with no saved sessions says so instead of showing an empty picker', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/resume');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'No saved sessions to resume'));
  });
});

test('/resume shows a picker; Enter on the default (newest) selection hands off to a restart with that session\'s id', async () => {
  await withTempDir(async (dir) => {
    // Seed two sessions directly via the store, independent of the running App instance.
    const seedStore = new SessionStore(dir);
    const olderId = await seedStore.save([userInputEntry('older session')]);
    await tick(100); // ensure a distinct updatedAt so ordering is unambiguous
    const newerId = await seedStore.save([userInputEntry('newer session')]);

    const { stdin, frames, restartCalls } = await setup({ dir });

    await submit(stdin, '/resume');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'older session'));
    assert.ok(anyFrameIncludes(frames, 'newer session'));

    stdin.write(ENTER); // default selection is index 0 = newest
    await tick(50);

    // The new process (spawned with --resume <newerId>) is what actually loads and displays
    // that session, and autosaves back into it - see the "launched with an initialSession" test
    // below for that side, which this process hands off to instead of doing in-place.
    assert.deepEqual(restartCalls, [newerId]);
    assert.notEqual(newerId, olderId);
  });
});

test('launched with an initialSession (as a /resume restart handoff would be), the resumed conversation reappears on screen and a later turn autosaves back into the same session id', async () => {
  await withTempDir(async (dir) => {
    const seedStore = new SessionStore(dir);
    const id = await seedStore.save([
      userInputEntry('what does this project do'),
      aiResponseEntry('it is a CLI coding harness'),
    ]);
    const data = await seedStore.load(id);
    assert.ok(data);

    const { stdin, frames, loop, store } = await setup({
      dir,
      initialSession: { id: data!.id, title: data!.title, messages: toWireMessages(data!.entries) },
    });

    assert.deepEqual(loop.getMessages(), []); // loadMessages() happens in cli.ts, before App mounts
    // The prior conversation must be visible on screen from the very first frame, not just
    // sitting in the loop's memory.
    assert.ok(anyFrameIncludes(frames, 'what does this project do'));
    assert.ok(anyFrameIncludes(frames, 'it is a CLI coding harness'));

    // A subsequent turn must autosave back into the resumed session's id, not create a new one.
    await submit(stdin, 'continuing the resumed session');
    await tick(100);

    const manifest = await store.readManifest();
    assert.equal(manifest.length, 1);
    const resumed = manifest.find((m) => m.id === id);
    assert.ok(resumed);
    assert.ok(resumed.messageCount > 2);
  });
});

test('a /resume restart handoff also restores the resumed session\'s own submit-history, and a later turn resaves it including the new submission', async () => {
  await withTempDir(async (dir) => {
    const seedStore = new SessionStore(dir);
    const id = await seedStore.save(
      [userInputEntry('what does this project do')],
      undefined,
      ['old draft one', 'old draft two'],
    );
    const data = await seedStore.load(id);
    assert.ok(data);

    const { stdin, frames, store } = await setup({
      dir,
      initialSession: {
        id: data!.id,
        title: data!.title,
        messages: toWireMessages(data!.entries),
        inputHistory: data!.inputHistory,
      },
    });

    // The resumed session's own submit-history is immediately recallable, before any typing.
    stdin.write(UP);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'old draft two'));
    // Back to the empty draft (there was nothing typed yet before UP) - otherwise the recalled
    // text would still be sitting in the box and the next submission would append onto it.
    stdin.write(DOWN);
    await tick(50);

    // A subsequent real turn's submission is appended to that same history, not replacing it -
    // and the resave persists the combined list back into the resumed session's own file.
    await submit(stdin, 'a brand new submission');
    await tick(100);

    const resaved = await store.load(id);
    assert.ok(resaved);
    assert.deepEqual(resaved.inputHistory, ['old draft one', 'old draft two', 'a brand new submission']);
  });
});

test('/resume: pressing Down before Enter selects the older (second) entry instead of the default newest', async () => {
  await withTempDir(async (dir) => {
    const seedStore = new SessionStore(dir);
    const olderId = await seedStore.save([userInputEntry('older session')]);
    await tick(100);
    await seedStore.save([userInputEntry('newer session')]);

    const { stdin, restartCalls } = await setup({ dir });

    await submit(stdin, '/resume');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(ENTER);
    await tick(50);

    assert.deepEqual(restartCalls, [olderId]);
  });
});

test('/resume: Escape cancels with no change and no session loaded', async () => {
  await withTempDir(async (dir) => {
    const seedStore = new SessionStore(dir);
    await seedStore.save([userInputEntry('a saved session')]);

    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/resume');
    await tick(50);
    stdin.write(ESCAPE);
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Resume cancelled'));
    assert.deepEqual(loop.getMessages(), []);
  });
});

test('/mode opens a picker listing all five modes', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/mode');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Choose a mode'));
    assert.ok(anyFrameIncludes(frames, 'Auto'));
    assert.ok(anyFrameIncludes(frames, 'Accept Edits'));
    assert.ok(anyFrameIncludes(frames, 'Plan'));
    assert.ok(anyFrameIncludes(frames, 'Plan-Write'));

    // Cancel rather than leaving the picker's pending promise (and processTurn) dangling
    // unresolved after the test ends.
    stdin.write(ESCAPE);
    await tick(50);
  });
});

test('Ctrl+C force-recovers the UI (not exit) even when the stuck turn never actually settles', async () => {
  await withTempDir(async (dir) => {
    // Real bug reported 2026-09-26: a genuinely hung session had no way to be stopped from the
    // keyboard at all (exitOnCtrlC: false + InputBox's own key.ctrl catch-all made Ctrl+C a
    // complete no-op). Escape alone doesn't cover this case either - it only *asks* the in-flight
    // call to abort, which does nothing if that signal never reaches whatever's actually stuck.
    // HangingProvider's promise never settles at all, so this proves the recovery is real and
    // unconditional - not just "the abort happened to work this time."
    const { stdin, frames, lastFrame } = await setup({ dir, provider: new HangingProvider() });

    await submit(stdin, 'this will hang forever');
    await waitFor(() => (lastFrame() ?? '').includes('Thinking...'));

    stdin.write('\u0003'); // Ctrl+C's raw byte
    await tick(100);

    assert.ok(anyFrameIncludes(frames, 'Stopped (Ctrl+C)'));
    assert.ok(!(lastFrame() ?? '').includes('Thinking...'));

    // Input must genuinely work again, not just look reset - submit a real new message and
    // confirm a fresh turn actually starts (the input box isn't still disabled underneath).
    const framesBeforeResubmit = frames.length;
    await submit(stdin, 'are you responsive now');
    await waitFor(() => frames.slice(framesBeforeResubmit).some((f) => f.includes('Thinking...')));
  });
});

test('a stale, force-recovered turn that eventually settles anyway never shows its late answer', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, lastFrame } = await setup({ dir, provider: new DelayedAnswerProvider(150) });

    await submit(stdin, 'first message');
    await waitFor(() => (lastFrame() ?? '').includes('Thinking...'));

    stdin.write('\u0003');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Stopped (Ctrl+C)'));

    // Wait past the provider's own delay so the abandoned call actually settles in the
    // background - its answer must never reach the screen, and it must not re-disable input.
    await tick(300);
    assert.ok(!anyFrameIncludes(frames, 'stale answer, arrived too late'));
    assert.ok(!(lastFrame() ?? '').includes('Thinking...'));
  });
});

test('Tab cycles through the five modes in order, independent of /mode', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    assert.ok((lastFrame() ?? '').includes('Mode: Manual'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Auto'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Accept Edits'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Plan'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Plan-Write'));

    // Wraps back around to Manual after the last mode.
    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Manual'));
  });
});

test('/set-sessionname with no active session says so instead of renaming', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/set-sessionname whatever');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'No active session yet'));
  });
});

test('/set-sessionname with no argument shows a usage error instead of renaming', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, store } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);

    await submit(stdin, '/set-sessionname');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Usage: /set-sessionname'));
    const manifest = await store.readManifest();
    assert.notEqual(manifest[0].title, ''); // untouched - still the auto-derived title
  });
});

test('/set-sessionname renames the current session, persisted to both the manifest and the session file', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, store } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);
    const before = await store.readManifest();
    const id = before[0].id;

    await submit(stdin, '/set-sessionname my custom title');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Session renamed to "my custom title".'));
    const data = await store.load(id);
    assert.equal(data?.title, 'my custom title');
    const manifest = await store.readManifest();
    assert.equal(manifest.find((m) => m.id === id)?.title, 'my custom title');
  });
});

test('/set opens a picker of /set-* commands; selecting one prefills the input box instead of running it', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, lastFrame, store } = await setup({ dir });

    await submit(stdin, '/set');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Choose a setting'));
    assert.ok(anyFrameIncludes(frames, '/set-sessionname'));

    stdin.write(ENTER); // only entry - selects /set-sessionname
    await waitFor(() => (lastFrame() ?? '').includes('/set-sessionname'));

    // The picker is gone and the command was NOT run yet - just handed to the input box for the
    // user to finish typing the argument onto.
    assert.equal((lastFrame() ?? '').includes('Choose a setting'), false);
    assert.equal(anyFrameIncludes(frames, 'Session renamed'), false);
    assert.deepEqual(await store.readManifest(), []);

    // Finish typing the argument and submit for real, proving the prefilled text is genuinely
    // live in the box (not just painted for one frame).
    await type(stdin, 'finished typing');
    stdin.write(ENTER);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'No active session yet')); // no session exists in this test
  });
});

test('/set: Escape cancels with no change', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/set');
    await tick(50);
    stdin.write(ESCAPE);
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Set cancelled'));
  });
});

test('typing "/set-" (without submitting) live-reveals the /set-* family, which the main palette otherwise hides entirely', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    // "/set" alone matches only the (non-hidden) /set command itself - the hidden family member
    // isn't shown yet.
    await type(stdin, '/set');
    await waitFor(() => (lastFrame() ?? '').includes('/set'));
    assert.equal((lastFrame() ?? '').includes('/set-sessionname'), false);

    // The trailing "-" is what flips it over to the family picker - matchCommands would show
    // nothing at all for this prefix (the hidden command is excluded even once its own prefix is
    // fully typed), so without this live picker the palette would just go blank here.
    await type(stdin, '-');
    await waitFor(() => (lastFrame() ?? '').includes('/set-sessionname'));
    assert.ok((lastFrame() ?? '').includes('Matching /set-* commands'));

    // Selecting it prefills the input box rather than submitting - same contract as /set's own
    // Enter-triggered picker.
    stdin.write(ENTER);
    await waitFor(() => (lastFrame() ?? '').includes('/set-sessionname '));
    assert.equal((lastFrame() ?? '').includes('Matching /set-* commands'), false);
  });
});

test('/config opens a picker of /config-* commands; selecting one prefills the input box instead of running it', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, lastFrame } = await setup({ dir });

    await submit(stdin, '/config');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Choose a setting'));
    assert.ok(anyFrameIncludes(frames, '/config-highlightcolor'));

    stdin.write(ENTER); // first entry - selects /config-highlightcolor
    await waitFor(() => (lastFrame() ?? '').includes('/config-highlightcolor'));

    // The picker is gone and the command was NOT run yet - just handed to the input box for the
    // user to finish typing the argument onto, same contract as /set's own picker.
    assert.equal((lastFrame() ?? '').includes('Choose a setting'), false);
    assert.equal(anyFrameIncludes(frames, 'Highlight color set'), false);
  });
});

test('typing "/config-" (without submitting) live-reveals the /config-* family, which the main palette otherwise hides entirely', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    // "/config" alone matches only the (non-hidden) /config command itself - hidden family
    // members aren't shown yet.
    await type(stdin, '/config');
    await waitFor(() => (lastFrame() ?? '').includes('/config'));
    assert.equal((lastFrame() ?? '').includes('/config-highlightcolor'), false);

    // The trailing "-" flips it over to the family picker, same live-reveal /set-* already has.
    await type(stdin, '-');
    await waitFor(() => (lastFrame() ?? '').includes('/config-highlightcolor'));
    assert.ok((lastFrame() ?? '').includes('Matching /config-* commands'));
  });
});

test('/config itself (unlike hidden /config-* entries) shows up in the bare "/" palette', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    await type(stdin, '/');
    await waitFor(() => (lastFrame() ?? '').includes('/config'));
  });
});

test('/config-highlightcolor with no argument shows a usage error, writes nothing', async () => {
  await withTempDir(async (dir) => {
    const projectRoot = dir;
    const { stdin, lastFrame } = await setup({ dir, projectRoot });

    // A trailing space (not the bare name alone) is how this is actually reachable in real use -
    // typing the bare name with no space keeps the live /config-* family picker open (see
    // composingConfigFamily/configFamilyOpen), which owns Enter itself (select+prefill) rather
    // than ever handing the keystroke to handleSubmit. A space is exactly what the picker's own
    // prefill already appends, and what ends "composing" the command name (isComposingCommand).
    await submit(stdin, '/config-highlightcolor ');
    await waitFor(() => (lastFrame() ?? '').includes('Usage: /config-highlightcolor'));

    const local = await new ConfigStore(projectRoot).readScope('local');
    assert.equal(local.highlightColor, undefined);
  });
});

test('/config-highlightcolor with an unrecognized color shows an error, writes nothing', async () => {
  await withTempDir(async (dir) => {
    const projectRoot = dir;
    const { stdin, lastFrame } = await setup({ dir, projectRoot });

    await submit(stdin, '/config-highlightcolor notarealcolor');
    await waitFor(() => (lastFrame() ?? '').includes('Unrecognized color "notarealcolor"'));

    const local = await new ConfigStore(projectRoot).readScope('local');
    assert.equal(local.highlightColor, undefined);
  });
});

test('/config-highlightcolor with no trusted project says so instead of writing anywhere', async () => {
  await withTempDir(async (dir) => {
    // No projectRoot passed - same as an untrusted/no-project run (App.tsx's own contract).
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/config-highlightcolor #112233');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'No trusted project in this directory'));
  });
});

test('/config-highlightcolor (bare) and /config-local-highlightcolor both write the same project-shared scope', async () => {
  await withTempDir(async (dir) => {
    const projectRoot = dir;
    const { stdin, frames, lastFrame } = await setup({ dir, projectRoot });

    await submit(stdin, '/config-highlightcolor #112233');
    await waitFor(() => (lastFrame() ?? '').includes('Highlight color set to #112233 (local)'));
    assert.equal((await new ConfigStore(projectRoot).readScope('local')).highlightColor, '#112233');
    // Never touches the global file.
    assert.equal(anyFrameIncludes(frames, '#112233 (global)'), false);

    await submit(stdin, '/config-local-highlightcolor blueBright');
    await waitFor(() => (lastFrame() ?? '').includes('Highlight color set to blueBright (local)'));
    assert.equal((await new ConfigStore(projectRoot).readScope('local')).highlightColor, 'blueBright');
  });
});

test('/config-global-highlightcolor writes only the global scope, isolated from the real ~/.o4c during the test', async () => {
  await withTempDir(async (dir) => {
    const configGlobalDir = join(dir, 'fake-global');
    const projectRoot = join(dir, 'project');
    const { stdin, lastFrame } = await setup({ dir: join(dir, 'sessions'), projectRoot, configGlobalDir });

    await submit(stdin, '/config-global-highlightcolor #445566');
    await waitFor(() => (lastFrame() ?? '').includes('Highlight color set to #445566 (global)'));

    const store = new ConfigStore(projectRoot, configGlobalDir);
    assert.equal((await store.readScope('global')).highlightColor, '#445566');
    // The project-shared (local) scope is untouched.
    assert.equal((await store.readScope('local')).highlightColor, undefined);
  });
});

test('/set-sessionsToSave with no argument shows a usage error, writes nothing', async () => {
  await withTempDir(async (dir) => {
    const projectRoot = dir;
    const { stdin, lastFrame } = await setup({ dir, projectRoot });

    await submit(stdin, '/set-sessionsToSave ');
    await waitFor(() => (lastFrame() ?? '').includes('Usage: /set-sessionsToSave'));

    const local = await new ConfigStore(projectRoot).readScope('local');
    assert.equal(local.sessionsToSave, undefined);
  });
});

test('/set-sessionsToSave with a non-numeric or non-positive value shows an error, writes nothing', async () => {
  await withTempDir(async (dir) => {
    const projectRoot = dir;
    const { stdin, lastFrame } = await setup({ dir, projectRoot });

    await submit(stdin, '/set-sessionsToSave abc');
    await waitFor(() => (lastFrame() ?? '').includes('"abc" isn\'t a positive whole number'));

    await submit(stdin, '/set-sessionsToSave 0');
    await waitFor(() => (lastFrame() ?? '').includes('"0" isn\'t a positive whole number'));

    await submit(stdin, '/set-sessionsToSave -3');
    await waitFor(() => (lastFrame() ?? '').includes('"-3" isn\'t a positive whole number'));

    const local = await new ConfigStore(projectRoot).readScope('local');
    assert.equal(local.sessionsToSave, undefined);
  });
});

test('/set-sessionsToSave with no trusted project says so instead of writing anywhere', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/set-sessionsToSave 5');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'No trusted project in this directory'));
  });
});

test('/set-sessionsToSave (bare) and /set-local-sessionsToSave both write the same project-shared scope, and take effect immediately', async () => {
  await withTempDir(async (dir) => {
    const projectRoot = dir;
    const { stdin, frames, lastFrame, store } = await setup({ dir, projectRoot });

    await submit(stdin, '/set-sessionsToSave 5');
    await waitFor(() => (lastFrame() ?? '').includes('Sessions to save set to 5 (local)'));
    assert.equal((await new ConfigStore(projectRoot).readScope('local')).sessionsToSave, 5);
    assert.equal(store.maxSessions, 5); // live effect, not just persisted for the next launch
    // Never touches the global file.
    assert.equal(anyFrameIncludes(frames, '(global)'), false);

    await submit(stdin, '/set-local-sessionsToSave 7');
    await waitFor(() => (lastFrame() ?? '').includes('Sessions to save set to 7 (local)'));
    assert.equal((await new ConfigStore(projectRoot).readScope('local')).sessionsToSave, 7);
    assert.equal(store.maxSessions, 7);
  });
});

test('/set-global-sessionsToSave writes only the global scope, isolated from the real ~/.o4c during the test', async () => {
  await withTempDir(async (dir) => {
    const configGlobalDir = join(dir, 'fake-global');
    const projectRoot = join(dir, 'project');
    const { stdin, lastFrame } = await setup({ dir: join(dir, 'sessions'), projectRoot, configGlobalDir });

    await submit(stdin, '/set-global-sessionsToSave 3');
    await waitFor(() => (lastFrame() ?? '').includes('Sessions to save set to 3 (global)'));

    const configStore = new ConfigStore(projectRoot, configGlobalDir);
    assert.equal((await configStore.readScope('global')).sessionsToSave, 3);
    // The project-shared (local) scope is untouched.
    assert.equal((await configStore.readScope('local')).sessionsToSave, undefined);
  });
});

test('Manual Mode (the default) prompts before write_file, and declining leaves the file untouched', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'manual-no.txt');
    const { stdin, frames } = await setup({ dir, provider: new WriteFileProvider(targetPath) });

    await submit(stdin, 'please write the file');
    await tick(100);

    assert.ok(anyFrameIncludes(frames, 'Allow write_file'));
    stdin.write(ENTER); // ConfirmDialog defaults to "No"
    await tick(100);

    await assert.rejects(() => readFile(targetPath, 'utf-8'));
  });
});

test('Escape on a write_file confirmation stops the whole turn, not just that one call - real bug 2026-09-26', async () => {
  await withTempDir(async (dir) => {
    // Real bug found via hands-on testing: Escape on a tool confirmation dialog only ever
    // declined that one call (ConfirmDialog's own Escape-cancels-as-No behavior), never actually
    // stopping the turn - so the model just tried again with its next write_file call, opening a
    // second confirm dialog right behind it ("hitting Esc here just lets every other next window
    // open"). TwoWriteFileProvider makes two sequential write_file calls across two provider
    // rounds, so this proves the second one never even gets attempted.
    const path1 = join(dir, 'first.txt');
    const path2 = join(dir, 'second.txt');
    const { stdin, frames, lastFrame } = await setup({ dir, provider: new TwoWriteFileProvider(path1, path2) });

    await submit(stdin, 'write two files');
    await waitFor(() => (lastFrame() ?? '').includes('Allow write_file'));

    stdin.write(ESCAPE);
    await tick(150);

    assert.ok(anyFrameIncludes(frames, 'Cancelled - your message is back in the input box'));
    // The second confirm dialog must never appear - the whole turn stopped, not just call #1.
    assert.ok(!anyFrameIncludes(frames, path2));
    await assert.rejects(() => readFile(path1, 'utf-8'));
    await assert.rejects(() => readFile(path2, 'utf-8'));
  });
});

test('Manual Mode: confirming yes actually runs write_file', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'manual-yes.txt');
    const { stdin } = await setup({ dir, provider: new WriteFileProvider(targetPath) });

    await submit(stdin, 'please write the file');
    await tick(100);
    stdin.write(DOWN); // move from "No" to "Yes"
    await tick(100);
    stdin.write(ENTER);

    // The real fs write happens after the confirm dialog resolves, through toolPolicy ->
    // tool execution -> the turn actually finishing - a fixed tick raced that chain under load
    // (confirmed: this test failed with ENOENT on a slow run). Poll for the real file instead.
    await waitFor(async () => {
      try {
        return (await readFile(targetPath, 'utf-8')) === 'hello';
      } catch {
        return false;
      }
    });
  });
});

test('switching to Auto mid-turn (Tab) takes effect on the very next tool call, not just the next turn', async () => {
  // Real bug found via hands-on testing, 2026-09-26: in a long turn with several sequential tool
  // calls, switching to Auto partway through kept confirming every remaining call anyway, as if
  // still in Manual mode, until a brand-new turn was started. Root cause was a stale closure over
  // `mode` inside toolPolicy - fixed via modeRef/plansDirRef in App.tsx. This test reproduces the
  // exact scenario: two write_file calls in one turn, mode switched to Auto in the gap between
  // them (while the first call's confirm dialog is still showing), and asserts the second call
  // runs with no confirmation prompt at all.
  //
  // Second real bug, found the same way, fixed later: the mode switch above only ever reached
  // *future* tool calls - an already-*open* dialog (the first call's, still on screen when Tab is
  // pressed) used to just sit there needing a manual Yes/No regardless of the new mode ("does not
  // close the window underneath asking for permission"), even though Auto's entire point is "don't
  // ask." Fixed via App.tsx's own mode-change effect, which re-resolves an open dialog against
  // whatever mode it's switched to. This test now covers both fixes: no DOWN/ENTER for the first
  // dialog either, once Tab lands on Auto.
  await withTempDir(async (dir) => {
    const path1 = join(dir, 'first.txt');
    const path2 = join(dir, 'second.txt');
    const { stdin, frames, lastFrame } = await setup({ dir, provider: new TwoWriteFileProvider(path1, path2) });

    await submit(stdin, 'write two files');
    // First write_file call: Manual mode (the default) confirms it, as always.
    await waitFor(() => (lastFrame() ?? '').includes('Allow write_file'));

    // Switch to Auto while that confirm dialog is still pending - Tab's mode-cycle handler is
    // always active regardless of what else is showing (App.tsx), so this is a real, reachable
    // sequence, not a contrived one.
    stdin.write(TAB);
    await tick(100);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Auto'));

    // Both calls now run with zero further confirmation - before either fix, this would hang here
    // waiting on a dialog nothing ever answers: the already-open first one (fix #2), or a second
    // one for the next call (fix #1).
    await waitFor(async () => {
      try {
        return (await readFile(path2, 'utf-8')) === 'second';
      } catch {
        return false;
      }
    });
    assert.equal(await readFile(path1, 'utf-8'), 'first');
    assert.equal((lastFrame() ?? '').includes('Allow write_file'), false);
  });
});

test('Plan Mode blocks a real write_file call end-to-end - the file is never created', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'blocked.txt');
    const { stdin, frames } = await setup({ dir, provider: new WriteFileProvider(targetPath) });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits -> Plan
    await tick(100);
    stdin.write(ENTER);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Plan'));

    await submit(stdin, 'please write the file');
    await tick(100);

    assert.ok(anyFrameIncludes(frames, 'Blocked by the current mode'));
    await assert.rejects(() => readFile(targetPath, 'utf-8'));
  });
});

test('Plan-Write mode allows write_file inside .o4c/plans/, end-to-end', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, '.o4c', 'plans', 'roadmap.md');
    const { stdin, frames } = await setup({
      dir,
      provider: new WriteFileProvider(targetPath),
      projectRoot: dir,
    });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits -> Plan -> Plan-Write
    await tick(100);
    stdin.write(ENTER);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Plan-Write'));

    await submit(stdin, 'please write the plan');
    await tick(100);

    assert.equal(await readFile(targetPath, 'utf-8'), 'hello');
  });
});

test('Plan-Write mode still blocks write_file outside .o4c/plans/, end-to-end', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'blocked.txt');
    const { stdin, frames } = await setup({
      dir,
      provider: new WriteFileProvider(targetPath),
      projectRoot: dir,
    });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits -> Plan -> Plan-Write
    await tick(100);
    stdin.write(ENTER);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Plan-Write'));

    await submit(stdin, 'please write the file');
    await tick(100);

    assert.ok(anyFrameIncludes(frames, 'Blocked by the current mode'));
    await assert.rejects(() => readFile(targetPath, 'utf-8'));
  });
});

test('the current mode is actually told to the model, not just enforced at the tool gate', async () => {
  await withTempDir(async (dir) => {
    const provider = new RecordingProvider();
    const { stdin, frames } = await setup({ dir, provider, projectRoot: dir });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits -> Plan
    await tick(100);
    stdin.write(ENTER);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Plan'));

    await submit(stdin, 'hello');
    await tick(100);

    assert.match(provider.lastSystemPrompt, /Current mode: Plan\./);
    assert.match(provider.lastSystemPrompt, /write_file and run_shell are both hard-disabled/);

    // Switching mode again changes the very next request's instruction too - proves this is
    // computed fresh per-turn from live state, not captured once at mount.
    stdin.write(TAB);
    await tick(200);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Plan-Write'));

    await submit(stdin, 'hello again');
    await tick(100);

    assert.match(provider.lastSystemPrompt, /Current mode: Plan-Write\./);
    assert.ok(provider.lastSystemPrompt.includes(join(dir, '.o4c', 'plans')));
  });
});

test('Auto Mode runs write_file with no confirmation prompt at all', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'auto.txt');
    const { stdin, lastFrame } = await setup({ dir, provider: new WriteFileProvider(targetPath) });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN); // Manual -> Auto
    await tick(100);
    stdin.write(ENTER);
    await tick(50);

    await submit(stdin, 'please write the file');
    await tick(100);

    assert.equal(await readFile(targetPath, 'utf-8'), 'hello');
    assert.equal((lastFrame() ?? '').includes('Allow write_file'), false);
  });
});

test('Accept Edits mode auto-runs write_file but still confirms run_shell', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'accept-edits.txt');
    const { stdin, frames } = await setup({ dir, provider: new WriteFileProvider(targetPath) });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits
    await tick(100);
    stdin.write(ENTER);
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Mode set to Accept Edits'));

    await submit(stdin, 'please write the file');
    await tick(100);

    assert.equal(await readFile(targetPath, 'utf-8'), 'hello');
  });
});

test('Accept Edits mode still confirms run_shell even though write_file is automatic', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir, provider: new RunShellProvider() });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(DOWN);
    await tick(100);
    stdin.write(ENTER);
    await tick(50);

    await submit(stdin, 'please run a command');
    await tick(100);

    assert.ok(anyFrameIncludes(frames, 'Allow run_shell'));
    // Answer "No" - denying is enough to prove the confirmation gate is real, and resolving it
    // lets processTurn actually finish instead of leaving a dangling pending promise (and the
    // Ink tree mounted) after the test ends.
    stdin.write(ESCAPE);
    await tick(50);
  });
});

// Terminal-resize handling is deliberately NOT part of App at all - it lives in
// src/ui/resizeReflowFix.ts, installed on process.stdout by cli.ts before render(), and is tested
// on its own in resizeReflowFix.test.ts. Two earlier in-App attempts are worth not repeating:
// bumping a `key` on <Static> to re-wrap history on resize (Static writes are permanent and
// additive - Static.js - so that appended a second copy of the whole conversation every time),
// and swapping the live region for a placeholder during a drag (every frame transition still
// went through Ink's same broken erase, so it only changed which stale frames got left behind).
// See the module's doc comment and docs/frontend-design.checklist.md §5e for the full history.
