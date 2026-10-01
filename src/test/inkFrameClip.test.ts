import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { Box, Text, render } from 'ink';
import { installResizeReflowFix } from '../ui/resizeReflowFix.js';

// Guards patches/ink+7.1.1.patch: a live frame as tall as the window must never be written, because
// each repaint of such a frame scrolls its top rows into scrollback (hundreds of duplicated lines
// were seen there on 2026-09-30). The patched Ink clips it to the newest viewportRows-1 rows.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

async function runCase(rows: number, cols: number): Promise<string[]> {
  const stdout = new FakeStdout(cols, rows);
  installResizeReflowFix(stdout as never);
  let setTick: (n: number) => void = () => {};
  const lines = rows + 15; // taller than the window; every third line wraps over several rows
  function App() {
    const [tick, setState] = React.useState(0);
    setTick = setState;
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      ...Array.from({ length: lines }, (_, i) =>
        React.createElement(Text, { key: i }, i % 3 === 0 ? `w${i} `.repeat(Math.ceil((cols * 2.3) / (String(i).length + 2))) : `live line ${i}`),
      ),
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
  const check = (label: string, from: number, lastTick: number) => {
    const written = stdout.writes.slice(from);
    const tallest = Math.max(0, ...written.map((s) => s.split('\n').length - 1));
    if (stdout.rows >= 3 && tallest >= stdout.rows) problems.push(`${label}: a write had ${tallest} rows, viewport ${stdout.rows}`);
    if (written.some((s) => s.includes('\x1b[J'))) problems.push(`${label}: full-clear ESC[J used`);
    if (written.some((s) => /\x1b\[\d+A\x1b\[J/.test(s))) problems.push(`${label}: corrective erase-up`);
    const text = written.join('');
    if (!text.includes('FOOTER')) problems.push(`${label}: footer missing`);
    if (!text.includes(`spinner ${lastTick}`)) problems.push(`${label}: latest spinner tick missing`);
  };
  await sleep(120);
  let mark = stdout.writes.length;
  for (let i = 1; i <= 6; i++) {
    setTick(i);
    await sleep(45);
  }
  await sleep(350);
  check('initial', mark, 6);

  stdout.rows = Math.max(3, Math.floor(rows / 2)); // shrink mid-run
  stdout.emit('resize');
  await sleep(450);
  mark = stdout.writes.length;
  for (let i = 7; i <= 10; i++) {
    setTick(i);
    await sleep(45);
  }
  await sleep(350);
  check('after shrink', mark, 10);

  stdout.rows = rows * 2; // grow and narrow mid-run
  stdout.columns = Math.max(10, Math.floor(cols * 0.7));
  stdout.emit('resize');
  await sleep(450);
  mark = stdout.writes.length;
  for (let i = 11; i <= 14; i++) {
    setTick(i);
    await sleep(45);
  }
  await sleep(350);
  check('after grow+narrow', mark, 14);
  app.unmount();
  return problems;
}

for (const [rows, cols] of [
  [3, 20],
  [10, 80],
  [24, 80],
  [131, 177],
  [300, 80],
] as const) {
  test(`a live frame taller than the window is clipped, never scrolled into scrollback (${rows} rows x ${cols} cols, incl. resize)`, async () => {
    assert.deepEqual(await runCase(rows, cols), []);
  });
}

test('a live frame that fits the window is left completely intact', async () => {
  const stdout = new FakeStdout(100, 40);
  const app = render(
    React.createElement(
      Box,
      { flexDirection: 'column' },
      ...Array.from({ length: 32 }, (_, i) => React.createElement(Text, { key: i }, `row ${i}`)),
    ),
    { stdout: stdout as never, stdin: fakeStdin() as never, patchConsole: false },
  );
  await sleep(200);
  const all = stdout.writes.join('');
  for (let i = 0; i < 32; i++) assert.ok(all.includes(`row ${i}\n`), `row ${i} missing`);
  app.unmount();
});
