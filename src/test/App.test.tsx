import { test } from 'node:test';
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
const DOWN = String.fromCharCode(27) + '[B';
const SHIFT_TAB = String.fromCharCode(27) + '[Z';

function tick(ms = 10): Promise<void> {
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
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition was not met within the timeout');
    }
    await tick(20);
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
  await tick();
  return { ...instance, loop, store, runLogger, restartCalls };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-app-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

test('a turn with many tool calls collapses the display past the cap, but logs every event in full', async () => {
  await withTempDir(async (dir) => {
    const { stdin, frames, runLogger } = await setup({ dir, provider: new ManyToolCallsProvider(15) });

    await submit(stdin, 'explore the codebase');
    await tick(200);

    assert.ok(anyFrameIncludes(frames, '[scan] '));
    assert.ok(anyFrameIncludes(frames, 'collapsed'));
    assert.ok(anyFrameIncludes(frames, 'done scanning'));

    const logPath = runLogger.getFilePath();
    assert.ok(logPath);
    const raw = await readFile(logPath as string, 'utf-8');
    const lines = raw.trim().split('\n');
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
    const { stdin, frames } = await setup({ dir });

    // /c matches /clear then /context, alphabetically - Down should move off /clear onto /context.
    await type(stdin, '/c');
    await waitFor(() => anyFrameIncludes(frames, '/context'));
    stdin.write(DOWN);
    await tick(50);
    stdin.write(ENTER);
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Session usage')); // /context's own output
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

test('a real turn autosaves the session, and /clear hands off to a restart with no resumeId', async () => {
  await withTempDir(async (dir) => {
    const { stdin, store, restartCalls } = await setup({ dir });

    await submit(stdin, 'first session message');
    await tick(100);

    const manifestAfterFirst = await store.readManifest();
    assert.equal(manifestAfterFirst.length, 1);
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
    await tick(20); // ensure a distinct updatedAt so ordering is unambiguous
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

test('/resume: pressing Down before Enter selects the older (second) entry instead of the default newest', async () => {
  await withTempDir(async (dir) => {
    const seedStore = new SessionStore(dir);
    const olderId = await seedStore.save([{ role: 'user', content: 'older session' }]);
    await tick(20);
    await seedStore.save([{ role: 'user', content: 'newer session' }]);

    const { stdin, restartCalls } = await setup({ dir });

    await submit(stdin, '/resume');
    await tick(50);
    stdin.write(DOWN);
    await tick(20);
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
    const { stdin, frames, store } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);

    await submit(stdin, '/wipe');
    await tick(50);
    stdin.write(DOWN); // move to "Yes"
    await tick(20);
    stdin.write(ENTER); // confirm first dialog as Yes
    await tick(50);
    stdin.write(ENTER); // second dialog still defaults to "No"
    await tick(50);

    assert.ok(anyFrameIncludes(frames, 'Wipe cancelled'));
    const after = await store.readManifest();
    assert.equal(after.length, 1);
  });
});

test('/wipe: Yes then Yes actually deletes the session from disk, then hands off to a restart with no resumeId', async () => {
  await withTempDir(async (dir) => {
    const { stdin, store, restartCalls } = await setup({ dir });

    await submit(stdin, 'a message to create a session');
    await tick(100);
    const before = await store.readManifest();
    const id = before[0].id;

    await submit(stdin, '/wipe');
    await tick(50);
    stdin.write(DOWN);
    await tick(20);
    stdin.write(ENTER); // first: Yes
    await tick(50);
    stdin.write(DOWN);
    await tick(20);
    stdin.write(ENTER); // second: Yes
    await tick(50);

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

test('Shift+Tab cycles through the four modes in order, independent of /mode', async () => {
  await withTempDir(async (dir) => {
    const { stdin, lastFrame } = await setup({ dir });

    assert.ok((lastFrame() ?? '').includes('Mode: Manual'));

    stdin.write(SHIFT_TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Auto'));

    stdin.write(SHIFT_TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Accept Edits'));

    stdin.write(SHIFT_TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Plan'));

    // Wraps back around to Manual after the last mode.
    stdin.write(SHIFT_TAB);
    await waitFor(() => (lastFrame() ?? '').includes('Mode: Manual'));
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
    await tick(20);
    stdin.write(ENTER);
    await tick(100);

    assert.equal(await readFile(targetPath, 'utf-8'), 'hello');
  });
});

test('Plan Mode blocks a real write_file call end-to-end - the file is never created', async () => {
  await withTempDir(async (dir) => {
    const targetPath = join(dir, 'blocked.txt');
    const { stdin, frames } = await setup({ dir, provider: new WriteFileProvider(targetPath) });

    await submit(stdin, '/mode');
    await tick(50);
    stdin.write(DOWN);
    await tick(20);
    stdin.write(DOWN);
    await tick(20);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits -> Plan
    await tick(20);
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
    await tick(20);
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
    await tick(20);
    stdin.write(DOWN); // Manual -> Auto -> Accept Edits
    await tick(20);
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
    await tick(20);
    stdin.write(DOWN);
    await tick(20);
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
