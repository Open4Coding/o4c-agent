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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
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
