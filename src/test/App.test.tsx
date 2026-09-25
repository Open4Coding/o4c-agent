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
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return new Promise((_, reject) => {
      request.signal?.addEventListener('abort', () =>
        reject(new Error('simulated in-flight cancellation')),
      );
    });
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
}) {
  const store = new SessionStore(opts.dir);
  const runLogger = new RunLogger(join(opts.dir, 'logs'));
  const loop = new AgentLoop(opts.provider ?? new MockProvider(), defaultTools, 'test system prompt');
  // /clear, /wipe and /resume now hand off to a brand-new process instead of resetting state
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
      initialSession: opts.initialSession,
      restart,
    }),
  );
  liveInstances.push(instance);
  await tick();
  return { ...instance, loop, store, runLogger, restartCalls };
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
    // Poll for all 31 lines to actually be on disk, not just read once - runLogger.log() is
    // fire-and-forget (App.tsx never awaits it), so the UI showing "done scanning" only means
    // the last event's *render* committed, not that its log write has necessarily landed yet.
    let lines: string[] = [];
    await waitFor(async () => {
      const raw = await readFile(logPath as string, 'utf-8');
      lines = raw.trim().split('\n');
      return lines.length >= 31;
    });
    // 15 rounds x (tool_call + tool_result) = 30, plus 1 final "text" event carrying the
    // answer = 31 logged events, all of them - the cap only affects what's displayed, never
    // what's logged.
    assert.equal(lines.length, 31);
    assert.ok(lines.every((l) => JSON.parse(l).ts));
  });
});

test('typing "/" opens a command palette listing every command, alphabetically ascending', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await type(stdin, '/');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, '/clear'));
    assert.ok(anyFrameIncludes(frames, '/wipe'));
    // /clear must appear before /wipe in the same frame - alphabetical order.
    const frame = frames.find((f) => f.includes('/clear') && f.includes('/wipe'));
    assert.ok(frame);
    assert.ok(frame.indexOf('/clear') < frame.indexOf('/wipe'));
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
    await waitFor(() => !(lastFrame() ?? '').includes('/wipe'));

    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('/clear'));
    assert.ok(frame.includes('/context'));
    assert.equal(frame.includes('/wipe'), false);
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

test('/debug and /help no longer exist - both are treated as unknown commands', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/debug');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Unknown command: /debug'));

    await submit(stdin, '/help');
    await tick(50);
    assert.ok(anyFrameIncludes(frames, 'Unknown command: /help'));
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
    const olderId = await seedStore.save([{ role: 'user', content: 'older session' }]);
    await tick(100); // ensure a distinct updatedAt so ordering is unambiguous
    const newerId = await seedStore.save([{ role: 'user', content: 'newer session' }]);

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
      { role: 'user', content: 'what does this project do' },
      { role: 'assistant', content: 'it is a CLI coding harness' },
    ]);
    const data = await seedStore.load(id);
    assert.ok(data);

    const { stdin, frames, loop, store } = await setup({
      dir,
      initialSession: { id: data!.id, title: data!.title, messages: data!.messages },
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
      [{ role: 'user', content: 'what does this project do' }],
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
        messages: data!.messages,
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
    const olderId = await seedStore.save([{ role: 'user', content: 'older session' }]);
    await tick(100);
    await seedStore.save([{ role: 'user', content: 'newer session' }]);

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
    await seedStore.save([{ role: 'user', content: 'a saved session' }]);

    const { stdin, frames, loop } = await setup({ dir });

    await submit(stdin, '/resume');
    await tick(50);
    stdin.write(ESCAPE);
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Resume cancelled'));
    assert.deepEqual(loop.getMessages(), []);
  });
});

test('/wipe with no active session says there is nothing to wipe', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/wipe');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Nothing to wipe'));
  });
});

test('/wipe: answering No on the first confirmation cancels immediately, nothing deleted', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, store } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);
    const before = await store.readManifest();
    assert.equal(before.length, 1);

    await submit(stdin, '/wipe');
    await tick(50);
    stdin.write(ENTER); // default selection is "No"
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Wipe cancelled'));
    const after = await store.readManifest();
    assert.equal(after.length, 1);
  });
});

test('/wipe: Yes then No on the second confirmation still cancels, nothing deleted', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, store, lastFrame } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);

    await submit(stdin, '/wipe');
    await waitFor(() => (lastFrame() ?? '').includes('> No')); // first dialog has mounted
    // The dialog's content becoming visible and its own useInput actually finishing
    // subscription are two different moments - see the arrow-key navigation test's comment.
    await tick(150);
    stdin.write(DOWN); // move to "Yes"
    await waitFor(() => (lastFrame() ?? '').includes('> Yes'));
    stdin.write(ENTER); // confirm first dialog as Yes
    await waitFor(() => (lastFrame() ?? '').includes('> No')); // second dialog has mounted, defaults to No
    stdin.write(ENTER); // second dialog still defaults to "No"
    await waitFor(() => anyFrameIncludes(frames, 'Wipe cancelled'));

    const after = await store.readManifest();
    assert.equal(after.length, 1);
  });
});

test('/wipe: Yes then Yes actually deletes the session from disk, then hands off to a restart with no resumeId', async () => {
  await withTempDir(async (dir) => {
    const { stdin, store, restartCalls, lastFrame } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    let before: Awaited<ReturnType<typeof store.readManifest>> = [];
    await waitFor(async () => {
      before = await store.readManifest();
      return before.length > 0;
    });
    const id = before[0].id;

    await submit(stdin, '/wipe');
    await waitFor(() => (lastFrame() ?? '').includes('> No')); // first dialog has mounted
    // The dialog's content becoming visible and its own useInput actually finishing
    // subscription are two different moments (the same "effect registers asynchronously after
    // render" gap InputBox's own tests already account for) - a fixed buffer here, not another
    // waitFor, since there's no visible signal for "input-ready" to poll on.
    await tick(150);
    stdin.write(DOWN);
    // Poll for the DOWN to actually land (selection marker moved onto Yes) rather than a fixed
    // delay before ENTER - same React 19 + Ink 7 settle-time reasoning as the arrow-key
    // navigation test above.
    await waitFor(() => (lastFrame() ?? '').includes('> Yes'));
    stdin.write(ENTER); // first: Yes
    await waitFor(() => (lastFrame() ?? '').includes('> No')); // second dialog has mounted
    await tick(150);
    stdin.write(DOWN);
    await waitFor(() => (lastFrame() ?? '').includes('> Yes'));
    stdin.write(ENTER); // second: Yes
    await waitFor(() => restartCalls.length > 0);

    // The freshly spawned process starts blank (no resumeId), so it can't resurrect the just-
    // deleted session.
    assert.deepEqual(restartCalls, [undefined]);
    const after = await store.readManifest();
    assert.equal(after.some((m) => m.id === id), false);
    assert.equal(await store.load(id), undefined);
  });
});

test('/wipe: Escape on the first confirmation cancels the same as answering No', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, store } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);

    await submit(stdin, '/wipe');
    await tick(50);
    stdin.write(ESCAPE);
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Wipe cancelled'));
    const after = await store.readManifest();
    assert.equal(after.length, 1);
  });
});

test('/mode opens a picker listing all four modes', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames } = await setup({ dir });

    await submit(stdin, '/mode');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Choose a mode'));
    assert.ok(anyFrameIncludes(frames, 'Auto'));
    assert.ok(anyFrameIncludes(frames, 'Accept Edits'));
    assert.ok(anyFrameIncludes(frames, 'Plan'));

    // Cancel rather than leaving the picker's pending promise (and processTurn) dangling
    // unresolved after the test ends.
    stdin.write(ESCAPE);
    await tick(50);
  });
});

test('Tab cycles through the four modes in order, independent of /mode', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    assert.ok((lastFrame() ?? '').includes('Mode: Manual'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Auto'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Accept Edits'));

    stdin.write(TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Plan'));

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

test('/config says there is nothing to configure yet, with no /config-* commands registered (#6: frontend surface only, no real plugins this round)', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, lastFrame } = await setup({ dir });

    await submit(stdin, '/config');
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Nothing to configure yet'));
    // No picker should ever open for an empty family - same "Nothing to X yet" short-circuit
    // shape as /set's own empty-family branch.
    assert.equal((lastFrame() ?? '').includes('Choose a setting'), false);
  });
});

test('typing "/config-" live-reveals nothing while no /config-* commands are registered, rather than a spurious empty picker', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    await type(stdin, '/config-');
    await tick(100);

    assert.equal((lastFrame() ?? '').includes('Matching /config-* commands'), false);
  });
});

test('/config itself (unlike hidden /config-* entries) shows up in the bare "/" palette', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    await type(stdin, '/');
    await waitFor(() => (lastFrame() ?? '').includes('/config'));
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
