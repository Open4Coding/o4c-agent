import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  expectedUp,
  installResizeReflowFix,
  measureFrame,
  type ReflowFixableStream,
} from '../ui/resizeReflowFix.js';

const CSI = '\x1B[';

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ansi-escapes' eraseLines, verbatim: what Ink's log-update prefixes every repaint with.
function eraseLines(count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) s += `${CSI}2K` + (i < count - 1 ? `${CSI}1A` : '');
  if (count) s += `${CSI}G`;
  return s;
}

// Exactly what Ink writes for a frame: erase the previous frame (previousLineCount = its lines
// + 1, or 0 before the first frame / right after a static commit), then the frame, then '\n'.
function inkFrame(frame: string, previousFrameLines?: number): string {
  return (previousFrameLines === undefined ? '' : eraseLines(previousFrameLines + 1)) + frame + '\n';
}

// A minimal stand-in for process.stdout: an EventEmitter with a settable `columns` and a
// recording `write`, mirroring the shape ink-testing-library's mock uses too.
class MockStdout extends EventEmitter {
  columns = 100;
  writes: string[] = [];
  write = (chunk: unknown): boolean => {
    this.writes.push(String(chunk));
    return true;
  };
}

// Same, plus a TTY-style handle whose live size can disagree with the cached `columns` - the
// few-ms gap between the console resizing and Node emitting 'resize'.
class LiveSizeStdout extends MockStdout {
  liveColumns = 100;
  _handle = {
    getWindowSize: (out: number[]): number => {
      out[0] = this.liveColumns;
      out[1] = 40;
      return 0;
    },
  };
}

const SETTLE = 20;

// The real live region's shape: a full-width 3-line bordered box plus a 44-char mode line.
const box = (w: number) => ['╭' + '─'.repeat(w - 2) + '╮', '│' + ' '.repeat(w - 2) + '│', '╰' + '─'.repeat(w - 2) + '╯'];
const MODE = 'Mode: Manual  (/mode or Shift+Tab to change)';
const frameAt = (w: number) => [...box(w), MODE].join('\n');
const spinnerFrameAt = (w: number) => ['⠙ Thinking...', ...box(w), MODE].join('\n');

test('measureFrame: every line fits -> rows equal lines, escape codes measure as nothing', () => {
  const chunk = inkFrame(frameAt(100), 4);
  assert.deepEqual(measureFrame(chunk, 100), { lines: 4, rows: 4 });
  assert.deepEqual(measureFrame(chunk, 200), { lines: 4, rows: 4 });
});

test('measureFrame: narrowing wraps only the lines wider than the new width', () => {
  const chunk = inkFrame(frameAt(100), 4);
  // 100-wide box lines wrap to 2 rows at width 60; the 44-char mode line still fits on one.
  assert.deepEqual(measureFrame(chunk, 60), { lines: 4, rows: 7 });
  // At width 30 the box lines take 4 rows each and the mode line 2.
  assert.deepEqual(measureFrame(chunk, 30), { lines: 4, rows: 14 });
});

test('measureFrame: an empty line still occupies one row', () => {
  assert.deepEqual(measureFrame(inkFrame('a\n\nb'), 80), { lines: 3, rows: 3 });
});

test("expectedUp reads how many rows a chunk's erase prefix will move up", () => {
  assert.equal(expectedUp(inkFrame(frameAt(100), 4)), 4);
  assert.equal(expectedUp(inkFrame(frameAt(100), 5)), 5);
  assert.equal(expectedUp(inkFrame(frameAt(100))), 0); // first frame / after a static commit
  assert.equal(expectedUp(eraseLines(5)), 4); // an erase-only log.clear() chunk
  assert.equal(expectedUp(`${CSI}?25l`), 0); // cursor hide
});

test('with no resize, frames pass straight through untouched', () => {
  const stdout = new MockStdout();
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  const f0 = inkFrame(frameAt(100));
  const f1 = inkFrame(spinnerFrameAt(100), 4);
  stdout.write(f0);
  stdout.write(f1);
  assert.deepEqual(stdout.writes, [f0, f1]);
  uninstall();
});

test('during a resize nothing is written; on settle the repaint is replayed against the reflowed frame', async () => {
  const stdout = new MockStdout();
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  const f0 = inkFrame(frameAt(100));
  stdout.write(f0);

  stdout.columns = 60;
  stdout.emit('resize');
  const f1 = inkFrame(frameAt(60), 4); // what Ink's own resize handler writes next
  stdout.write(f1);
  assert.deepEqual(stdout.writes, [f0]); // held, not forwarded

  await tick(SETTLE * 3);
  // f0 reflowed to 7 rows at width 60 but f1's prefix will only move up 4: erase all 7 in
  // place, then 4 newlines down so that "up 4" lands exactly on f0's true top.
  assert.deepEqual(stdout.writes, [f0, `${CSI}7A${CSI}J\n\n\n\n`, f1]);
  uninstall();
});

test('intermediate live frames from a multi-step drag are skipped; only the final one is replayed', async () => {
  const stdout = new MockStdout();
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  const f0 = inkFrame(frameAt(100));
  stdout.write(f0);

  stdout.columns = 60;
  stdout.emit('resize');
  stdout.write(inkFrame(frameAt(60), 4));
  await tick(SETTLE / 2); // still within the settle window
  stdout.columns = 40;
  stdout.emit('resize');
  const f2 = inkFrame(frameAt(40), 4);
  stdout.write(f2);

  await tick(SETTLE * 3);
  // f0 at width 40: three 100-wide lines -> 3 rows each, the mode line -> 2 rows = 11 rows.
  assert.deepEqual(stdout.writes, [f0, `${CSI}11A${CSI}J\n\n\n\n`, f2]);
  uninstall();
});

test('a static commit that lands mid-drag is preserved, in order, and reconciled correctly', async () => {
  const stdout = new MockStdout();
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  const f0 = inkFrame(frameAt(100));
  stdout.write(f0);

  stdout.columns = 60;
  stdout.emit('resize');
  // Ink committing a new <Static> block: clear the live frame, write the static text, rewrite
  // the live frame with no erase prefix (previousLineCount was reset to 0 by clear()).
  const clear = eraseLines(5);
  const staticChunk = 'assistant: hello there\n';
  const fAfterStatic = inkFrame(frameAt(60));
  stdout.write(clear);
  stdout.write(staticChunk);
  stdout.write(fAfterStatic);
  const fLast = inkFrame(spinnerFrameAt(60), 4);
  stdout.write(fLast);

  await tick(SETTLE * 3);
  assert.deepEqual(stdout.writes, [
    f0,
    // clear's prefix expects 4 rows but f0 is 7 rows wide-reflowed: reconcile first.
    `${CSI}7A${CSI}J\n\n\n\n`,
    clear,
    staticChunk,
    fAfterStatic, // no prefix -> nothing to reconcile, written right after the static text
    fLast, // expects 4 rows; fAfterStatic is 4 rows at width 60 -> already exact
  ]);
  uninstall();
});

test('a frame arriving after the console narrowed but before Node knows is held, not written', async () => {
  // The scenario that only ever showed up with a real model: the spinner repaints every 80ms
  // and can land in the gap before Node's 'resize' fires. Detected via the live handle size.
  const stdout = new LiveSizeStdout();
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  const f0 = inkFrame(frameAt(100));
  stdout.write(f0);

  stdout.liveColumns = 60; // console already narrowed; `columns` still says 100
  const spinner = inkFrame(spinnerFrameAt(100), 4); // Ink laid this out at the stale width
  stdout.write(spinner);
  assert.deepEqual(stdout.writes, [f0]); // held

  stdout.columns = 60;
  stdout.emit('resize');
  const f1 = inkFrame(frameAt(60), 5); // Ink's resize repaint, expecting the 5-line spinner frame
  stdout.write(f1);

  await tick(SETTLE * 3);
  // The stale-width spinner frame is skipped entirely. f1 expects 5 rows above the cursor but
  // what's actually there is f0, 7 rows at width 60: erase, then 5 newlines down.
  assert.deepEqual(stdout.writes, [f0, `${CSI}7A${CSI}J\n\n\n\n\n`, f1]);
  uninstall();
});

test('widening needs no correction: the repaint is replayed as-is', async () => {
  const stdout = new MockStdout();
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  const f0 = inkFrame(frameAt(100));
  stdout.write(f0);

  stdout.columns = 160;
  stdout.emit('resize');
  const f1 = inkFrame(frameAt(160), 4);
  stdout.write(f1);

  await tick(SETTLE * 3);
  assert.deepEqual(stdout.writes, [f0, f1]);
  uninstall();
});

test('uninstall flushes anything still held, removes the listener and restores write', async () => {
  const stdout = new MockStdout();
  const originalWrite = stdout.write;
  const uninstall = installResizeReflowFix(stdout, { settleMs: SETTLE });
  assert.notEqual(stdout.write, originalWrite);
  assert.equal(stdout.listenerCount('resize'), 1);

  const f0 = inkFrame(frameAt(100));
  stdout.write(f0);
  stdout.emit('resize');
  const f1 = inkFrame(frameAt(100), 4);
  stdout.write(f1);
  assert.deepEqual(stdout.writes, [f0]);

  uninstall();
  assert.deepEqual(stdout.writes, [f0, f1]);
  assert.equal(stdout.write, originalWrite);
  assert.equal(stdout.listenerCount('resize'), 0);
});

test("registers ahead of any pre-existing 'resize' listeners (Ink's own), even when installed after render()", () => {
  // ink-testing-library's render() runs the real ink `render`, whose constructor subscribes its
  // own resize listener first (outside CI - see is-in-ci in ink.js). Installing afterward must
  // still put ours FIRST, or Ink's repaint would go out before this hook starts holding it.
  // Assertions don't depend on how many listeners Ink registered (0 under CI), only on ordering.
  const { stdout } = render(React.createElement(() => null));
  const before = stdout.listeners('resize');
  const uninstall = installResizeReflowFix(stdout as unknown as ReflowFixableStream);
  const after = stdout.listeners('resize');

  assert.equal(after.length, before.length + 1);
  assert.ok(!before.includes(after[0]));
  for (const fn of before) assert.ok(after.includes(fn));
  uninstall();
});
