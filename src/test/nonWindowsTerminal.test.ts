import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { installResizeReflowFix } from '../ui/resizeReflowFix.js';
import { readMountPoint } from '../session/gitInfo.js';

// Next Up item 6: Ink's non-Windows render branch, and our own POSIX-only paths, have never
// executed - every run of this project has been on Windows Terminal/PowerShell. These tests
// exercise those branches offline, on whatever machine runs the suite.
//
// Deliberately NOT a static `import ... from 'ink'`: Ink decides its platform behaviour once, at
// module-evaluation time (`const isWindowsConsole = process.platform === 'win32'`), so the fake
// has to be in place before the first import of it. node:test runs each test file in its own
// process, so faking it here cannot leak into another file.

const INK_SOURCE = 'node_modules/ink/build/ink.js';

type ClearArgs = {
  isTty: boolean;
  viewportRows: number;
  previousOutputHeight: number;
  nextOutputHeight: number;
  isUnmounting: boolean;
};

/**
 * Ink's real `shouldClearTerminalForFrame`, lifted out of the shipped file and instantiated with
 * `isWindowsConsole` forced either way. Reading the real source rather than re-implementing it is
 * the point: a copy would drift, and this is the one function whose behaviour differs by platform.
 */
function platformDecision(isWindowsConsole: boolean): (a: ClearArgs) => boolean {
  const src = readFileSync(INK_SOURCE, 'utf8');
  const start = src.indexOf('const shouldClearTerminalForFrame = ');
  const end = src.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, `${INK_SOURCE} no longer defines shouldClearTerminalForFrame - re-check this test against the new Ink before trusting it`);
  const body = src.slice(start, end + 3);
  const make = new Function('isWindowsConsole', `${body}\nreturn shouldClearTerminalForFrame;`) as (
    w: boolean,
  ) => (a: ClearArgs) => boolean;
  return make(isWindowsConsole);
}

test('Ink reads process.platform exactly once, and only to compare against win32', () => {
  const src = readFileSync(INK_SOURCE, 'utf8');
  const reads = src.match(/process\.platform/g) ?? [];
  assert.equal(
    reads.length,
    1,
    `Ink now reads process.platform ${reads.length} times; "non-Windows" may no longer be a single branch`,
  );
  assert.match(src, /process\.platform === 'win32'/);
  // Which is why testing linux is enough to cover darwin, freebsd and the rest: Ink does not
  // distinguish between them, so there is exactly one non-Windows path, not one per OS.
});

test("the frame clip makes Ink's only platform branch unreachable: win32 and POSIX agree on every state we can produce", () => {
  const win = platformDecision(true);
  const posix = platformDecision(false);

  // Class A - steady state. patches/ink+7.1.1.patch clips any frame to `viewportRows - 1` before
  // this decision is taken, so both the frame being written and the one before it are bounded.
  // Class B - the frame right after a SHRINKING resize, the one case where the previous height can
  // exceed the current viewport: it was clipped against the old, larger window.
  let steady = 0;
  let afterShrink = 0;
  const divergent: string[] = [];

  for (let viewportRows = 3; viewportRows <= 60; viewportRows++) {
    for (let previousOutputHeight = 0; previousOutputHeight <= 200; previousOutputHeight++) {
      for (let nextOutputHeight = 0; nextOutputHeight <= viewportRows - 1; nextOutputHeight++) {
        for (const isUnmounting of [false, true]) {
          const args = { isTty: true, viewportRows, previousOutputHeight, nextOutputHeight, isUnmounting };
          if (previousOutputHeight <= viewportRows - 1) steady++;
          else afterShrink++;
          if (win(args) !== posix(args) && divergent.length < 5) {
            divergent.push(
              `viewport=${viewportRows} prev=${previousOutputHeight} next=${nextOutputHeight} unmount=${isUnmounting}`,
            );
          }
        }
      }
    }
  }

  assert.deepEqual(divergent, [], 'a clipped frame must decide the same way on both platforms');
  assert.ok(steady > 100_000 && afterShrink > 100_000, `thin coverage: ${steady} steady, ${afterShrink} post-shrink`);
});

test('without the clip the platforms really do disagree - so the test above is not vacuous', () => {
  const win = platformDecision(true);
  const posix = platformDecision(false);
  let states = 0;
  let divergent = 0;
  // Exactly what the clip prevents: a frame at or above the viewport. On Windows ANY such frame
  // forces a full terminal clear; on POSIX it takes the incremental erase path unless it also
  // overflows. That difference is the reason this item existed.
  for (let viewportRows = 3; viewportRows <= 60; viewportRows++) {
    for (let previousOutputHeight = 0; previousOutputHeight <= viewportRows + 4; previousOutputHeight++) {
      for (let nextOutputHeight = viewportRows; nextOutputHeight <= viewportRows + 20; nextOutputHeight++) {
        const args = { isTty: true, viewportRows, previousOutputHeight, nextOutputHeight, isUnmounting: false };
        states++;
        if (win(args) !== posix(args)) divergent++;
      }
    }
  }
  assert.ok(divergent > 0, 'the extraction or the branch is wrong: unclipped frames must diverge');
  assert.ok(
    divergent / states > 0.02,
    `only ${divergent}/${states} unclipped states diverge, expected a few percent`,
  );
});

class FakeStdout extends EventEmitter {
  isTTY = true;
  writes: string[] = [];
  constructor(public columns: number, public rows: number) {
    super();
  }
  write(chunk: unknown): boolean {
    this.writes.push(String(chunk));
    return true;
  }
}

function fakeStdin(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    setEncoding() {},
    read() {
      return null;
    },
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('a too-tall frame renders correctly through the POSIX branch, including across a shrink', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  assert.equal(process.platform, 'linux');
  // First import of Ink in this process, so it evaluates its platform check against the fake.
  const { Box, Text, render } = await import('ink');

  const rows = 24;
  const stdout = new FakeStdout(80, rows);
  installResizeReflowFix(stdout as never);
  let setTick: (n: number) => void = () => {};
  function App(): React.ReactElement {
    const [tick, setState] = React.useState(0);
    setTick = setState;
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      ...Array.from({ length: rows + 15 }, (_, i) => React.createElement(Text, { key: i }, `live line ${i}`)),
      React.createElement(Text, { key: 'spin' }, `spinner ${tick}`),
      React.createElement(Text, { key: 'foot' }, 'FOOTER'),
    );
  }
  const app = render(React.createElement(App), {
    stdout: stdout as never,
    stdin: fakeStdin() as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  const problems: string[] = [];
  const check = (label: string, from: number, lastTick: number): void => {
    const written = stdout.writes.slice(from);
    const tallest = Math.max(0, ...written.map((s) => s.split('\n').length - 1));
    if (tallest >= stdout.rows) problems.push(`${label}: a write had ${tallest} rows, viewport ${stdout.rows}`);
    const text = written.join('');
    if (!text.includes('FOOTER')) problems.push(`${label}: footer missing`);
    if (!text.includes(`spinner ${lastTick}`)) problems.push(`${label}: latest tick missing`);
  };

  await sleep(120);
  let mark = stdout.writes.length;
  for (let i = 1; i <= 5; i++) {
    setTick(i);
    await sleep(45);
  }
  await sleep(300);
  check('steady', mark, 5);

  stdout.rows = 12; // the Class B case above, now for real: previous frame taller than the viewport
  stdout.emit('resize');
  await sleep(400);
  mark = stdout.writes.length;
  for (let i = 6; i <= 9; i++) {
    setTick(i);
    await sleep(45);
  }
  await sleep(300);
  check('after shrink', mark, 9);

  app.unmount();
  assert.deepEqual(problems, []);
});

test("gitInfo's POSIX mount-point walk runs instead of the win32 early return", async () => {
  // readMountPoint reads process.platform per call, so this needs no module trickery. On Windows
  // the device-id walk has simply never executed - the first line of the function returns before
  // it. Here it does run, over a real directory, which is what has never been exercised.
  const dir = await mkdtemp(join(tmpdir(), 'o4c-posix-'));
  const original = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const mount = await readMountPoint(dir);
    assert.ok(mount, 'the walk must still name a volume');
    assert.ok(!mount.includes('\\'), `${mount} kept a backslash; the label is normalised to forward slashes`);
    assert.ok(!/.\/$/.test(mount), `${mount} ends in a separator and would render doubled`);
    assert.ok(mount.length > 0);
    // Bounded, too: MAX_PARENTS caps the climb, so a deep path cannot walk forever.
    const deep = join(dir, 'a', 'b', 'c', 'd', 'e');
    await assert.doesNotReject(async () => readMountPoint(deep));
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});
