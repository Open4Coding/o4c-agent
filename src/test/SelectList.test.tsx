import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { CONTINUATION_INDENT, MARKER_WIDTH, SelectList, wrapRow } from '../ui/SelectList.js';

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
      rowText: (item: string) => item,
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
      rowText: (item: string) => item,
    }),
  );
  await tick();
  await press(instance.stdin, ENTER);
  assert.equal(selected, 'only-one');
});

test('a long row wraps with its continuation lines starting exactly 4 cells in - 2 further than the first line\'s text', async () => {
  const long = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ');
  const { lastFrame } = render(
    React.createElement(SelectList, {
      items: [long, 'a short row'],
      getKey: (s: string) => s.slice(0, 10) + s.length,
      rowText: (s: string) => s,
      onSelect: () => {},
    }),
  );
  for (let i = 0; i < 40 && !(lastFrame() ?? '').includes('word59'); i++) await tick();
  const rowLines = (lastFrame() ?? '').split('\n').filter((l) => /word[0-9]/.test(l));
  assert.ok(rowLines.length >= 3, 'the long row wrapped over several lines, saw ' + rowLines.length);
  // Left border, then one cell of padding, then the row's own columns.
  assert.ok(/^.{1} > word0 /.test(rowLines[0]), 'the first line is marker then text: ' + JSON.stringify(rowLines[0].slice(0, 14)));
  for (const line of rowLines.slice(1)) {
    assert.ok(
      /^.{1} {5}word[0-9]/.test(line),
      'a continuation line starts exactly 4 cells in (5 spaces after the border): ' + JSON.stringify(line.slice(0, 14)),
    );
  }
  assert.equal(CONTINUATION_INDENT, 4);
  assert.equal(MARKER_WIDTH, 2);
});

test('an unselected row sits in the same text column as the selected one, with or without a rowColor', async () => {
  const { lastFrame } = render(
    React.createElement(SelectList, {
      items: ['alpha', 'beta'],
      getKey: (s: string) => s,
      rowText: (s: string) => s,
      rowColor: (_s: string, selected: boolean) => (selected ? 'red' : undefined),
      onSelect: () => {},
    }),
  );
  for (let i = 0; i < 40 && !(lastFrame() ?? '').includes('beta'); i++) await tick();
  const frame = lastFrame() ?? '';
  assert.ok(/> alpha/.test(frame));
  assert.ok(/ {3}beta/.test(frame), 'the unselected row is indented to the same text column');
});

test('wrapRow puts the first line in firstWidth cells and later lines in continuationWidth cells', () => {
  assert.deepEqual(wrapRow('aaa bbb ccc ddd', 7, 3), ['aaa bbb', 'ccc', 'ddd']);
  assert.deepEqual(wrapRow('short', 20, 18), ['short']);
  assert.deepEqual(wrapRow('', 10, 8), ['']);
});

test('wrapRow splits a word that is longer than a whole line, and counts wide characters as two cells', () => {
  assert.deepEqual(wrapRow('abcdefghij', 4, 3), ['abcd', 'efg', 'hij']);
  // each of these characters is two cells wide: only two fit in 4 cells
  assert.deepEqual(wrapRow('\u4e2d\u6587\u5b57\u7b26', 4, 4), ['\u4e2d\u6587', '\u5b57\u7b26']);
});

test('wrapRow joins embedded newlines into single spaces so a row never contains a hard break', () => {
  assert.deepEqual(wrapRow('one\ntwo   three', 40, 38), ['one two   three']);
});
