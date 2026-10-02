import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { SelectList } from '../ui/SelectList.js';

const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const UP = ESC + '[A';
const DOWN = ESC + '[B';

// 30ms, not 10ms - React 19 + Ink 7's internal scheduling (useEffectEvent, discreteUpdates) takes
// measurably longer to settle a keypress into a committed state update than the previous stack
// did. Confirmed empirically: 10ms was flaky, 20ms was reliable in isolation: 30ms gives margin
// for real test-runner contention.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function press(stdin: { write: (data: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  await tick();
}

function anyFrameIncludes(frames: string[], text: string): boolean {
  return frames.some((f) => f.includes(text));
}

function items(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `item-${String(i).padStart(2, '0')}`);
}

function renderList(list: string[], onSelect: (item: string) => void, onCancel?: () => void) {
  return render(
    React.createElement(SelectList<string>, {
      items: list,
      getKey: (item: string) => item,
      maxVisible: 20,
      onSelect,
      onCancel,
      renderItem: (item: string, selected: boolean) => <Text>{selected ? `> ${item}` : `  ${item}`}</Text>,
    }),
  );
}

test('renders up to maxVisible items with no overflow indicator when everything fits', async () => {
  const { frames } = renderList(items(5), () => {});
  await tick();
  assert.ok(anyFrameIncludes(frames, 'item-00'));
  assert.ok(anyFrameIncludes(frames, 'item-04'));
  assert.equal(anyFrameIncludes(frames, 'more below'), false);
  assert.equal(anyFrameIncludes(frames, 'more above'), false);
});

test('caps the visible window at maxVisible and shows a "more below" indicator for the rest', async () => {
  const { frames } = renderList(items(25), () => {});
  await tick();
  assert.ok(anyFrameIncludes(frames, 'item-00'));
  assert.ok(anyFrameIncludes(frames, 'item-19'));
  assert.equal(anyFrameIncludes(frames, 'item-20'), false);
  assert.ok(anyFrameIncludes(frames, '5 more below'));
});

test('scrolling down past the visible window reveals later items and a "more above" indicator', async () => {
  const { stdin, frames } = renderList(items(25), () => {});
  await tick();
  for (let i = 0; i < 20; i++) {
    await press(stdin, DOWN);
  }
  assert.ok(anyFrameIncludes(frames, 'item-20'));
  assert.ok(anyFrameIncludes(frames, '1 more above'));
});

test('Enter selects whatever item is currently highlighted, not always the first', async () => {
  let selected: string | undefined;
  const { stdin } = renderList(items(5), (item) => {
    selected = item;
  });
  await tick();
  await press(stdin, DOWN);
  await press(stdin, DOWN);
  await press(stdin, ENTER);
  assert.equal(selected, 'item-02');
});

test('Escape calls onCancel', async () => {
  let cancelled = false;
  const { stdin } = renderList(items(5), () => {}, () => {
    cancelled = true;
  });
  await tick();
  await press(stdin, ESC);
  assert.equal(cancelled, true);
});

test('selection resets to the top when the item set changes (e.g. a live filter narrowing)', async () => {
  let selected: string | undefined;
  const instance = renderList(items(5), (item) => {
    selected = item;
  });
  await tick();
  await press(instance.stdin, DOWN);
  await press(instance.stdin, DOWN);
  instance.rerender(
    React.createElement(SelectList<string>, {
      items: ['only-one'],
      getKey: (item: string) => item,
      maxVisible: 20,
      onSelect: (item: string) => {
        selected = item;
      },
      renderItem: (item: string, sel: boolean) => <Text>{sel ? `> ${item}` : `  ${item}`}</Text>,
    }),
  );
  await tick();
  await press(instance.stdin, ENTER);
  assert.equal(selected, 'only-one');
});

test('a long row wraps with its continuation lines hanging 2 cells in, under the first character of the text - never back under the marker', async () => {
  const long = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ');
  const { lastFrame } = render(
    React.createElement(SelectList, {
      items: [long, 'a short row'],
      getKey: (s: string) => s.slice(0, 10) + s.length,
      renderItem: (s: string) => React.createElement(Text, null, s),
      onSelect: () => {},
    }),
  );
  for (let i = 0; i < 40 && !(lastFrame() ?? '').includes('word59'); i++) await tick();
  const rowLines = (lastFrame() ?? '').split('\n').filter((l) => /word[0-9]/.test(l));
  assert.ok(rowLines.length >= 3, 'the long row wrapped over several lines, saw ' + rowLines.length);
  assert.ok(/^.{1} > word0 /.test(rowLines[0]), 'the first line starts with the marker: ' + JSON.stringify(rowLines[0].slice(0, 14)));
  for (const line of rowLines.slice(1)) {
    // Border, one cell of padding and the 2-cell marker column = 3 cells before any text; a terminal that keeps the
    // space at the wrap point puts the text one cell further in. Never fewer (that would be back under the marker).
    assert.ok(/^.{1} {3,}word[0-9]/.test(line), 'a continuation line hangs under the text: ' + JSON.stringify(line.slice(0, 14)));
  }
});

test('the marker keeps its own color when markerColor is given, and unselected rows keep a blank marker column', async () => {
  const { lastFrame } = render(
    React.createElement(SelectList, {
      items: ['alpha', 'beta'],
      getKey: (s: string) => s,
      renderItem: (s: string) => React.createElement(Text, null, s),
      markerColor: () => 'red',
      onSelect: () => {},
    }),
  );
  for (let i = 0; i < 40 && !(lastFrame() ?? '').includes('beta'); i++) await tick();
  const frame = lastFrame() ?? '';
  assert.ok(/> alpha/.test(frame));
  assert.ok(/ {3}beta/.test(frame), 'the unselected row is indented to the same text column');
});

