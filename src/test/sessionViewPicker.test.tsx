import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  SessionViewPicker,
  initialRowIndex,
  sessionViewRows,
  type SessionViewChoice,
  type SessionViewScope,
} from '../ui/SessionViewPicker.js';
import type { SessionView } from '../ui/formatEntries.js';

const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const DOWN = ESC + '[B';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition was not met within the timeout');
    await sleep(25);
  }
}

function mount(opts: {
  scope: SessionViewScope;
  currentValue: SessionView;
  storedValue: SessionView | undefined;
  globalValue?: SessionView;
}) {
  const chosen: SessionViewChoice[] = [];
  let cancelled = 0;
  const app = render(
    React.createElement(SessionViewPicker, {
      scope: opts.scope,
      currentValue: opts.currentValue,
      storedValue: opts.storedValue,
      globalValue: opts.globalValue ?? 'compact',
      onSelect: (c) => chosen.push(c),
      onCancel: () => {
        cancelled++;
      },
      highlightColor: '#FFBF00',
    }),
  );
  return { ...app, chosen, cancelled: () => cancelled };
}

test('the project picklist has default (global), compact and full; the global picklist has only compact and full', () => {
  assert.deepEqual(sessionViewRows('local', 'compact').map((r) => r.choice), ['default', 'compact', 'full']);
  assert.deepEqual(sessionViewRows('global', 'compact').map((r) => r.choice), ['compact', 'full']);
  assert.equal(sessionViewRows('local', 'full')[0].label, 'default (global)');
  assert.ok(sessionViewRows('local', 'full')[0].description.includes('currently full'));
});

test('the picklist opens on the tier\'s own stored value, or on the first row when it has none', () => {
  const local = sessionViewRows('local', 'compact');
  assert.equal(initialRowIndex(local, undefined), 0); // default (global)
  assert.equal(initialRowIndex(local, 'compact'), 1);
  assert.equal(initialRowIndex(local, 'full'), 2);
  const global = sessionViewRows('global', 'compact');
  assert.equal(initialRowIndex(global, undefined), 0); // compact
  assert.equal(initialRowIndex(global, 'full'), 1);
});

test('the project picklist shows all three rows, marks the current value, and opens on the stored one', async () => {
  const { frames, lastFrame } = mount({ scope: 'local', currentValue: 'full', storedValue: 'full' });
  await waitFor(() => frames.some((f) => f.includes('default (global)')));
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('compact'));
  assert.ok(frame.includes('full'));
  assert.ok(/> full[^\n]*\(current\)/.test(frame), 'opens on the full row, marked (current)');
  assert.equal(frame.includes('> default (global)'), false);
});

test('with no project value the picklist opens on default (global)', async () => {
  const { frames, lastFrame } = mount({ scope: 'local', currentValue: 'compact', storedValue: undefined });
  await waitFor(() => frames.some((f) => f.includes('default (global)')));
  assert.ok((lastFrame() ?? '').includes('> default (global)'));
});

test('Enter picks the highlighted row, arrows move the highlight, and Esc cancels without choosing', async () => {
  const picked = mount({ scope: 'local', currentValue: 'compact', storedValue: undefined });
  await waitFor(() => picked.frames.some((f) => f.includes('default (global)')));
  await sleep(150); // the list's key handler registers just after its first frame paints
  picked.stdin.write(DOWN);
  await waitFor(() => (picked.lastFrame() ?? '').includes('> compact'));
  picked.stdin.write(DOWN);
  await waitFor(() => (picked.lastFrame() ?? '').includes('> full'));
  picked.stdin.write(ENTER);
  await waitFor(() => picked.chosen.length > 0);
  assert.deepEqual(picked.chosen, ['full']);

  const cancelled = mount({ scope: 'global', currentValue: 'compact', storedValue: undefined });
  await waitFor(() => cancelled.frames.some((f) => f.includes('(global)')));
  await sleep(150);
  cancelled.stdin.write(ESC);
  await waitFor(() => cancelled.cancelled() > 0);
  assert.deepEqual(cancelled.chosen, []);
});

test('the global picklist is titled as global and offers no default row', async () => {
  const { frames, lastFrame } = mount({ scope: 'global', currentValue: 'compact', storedValue: undefined });
  await waitFor(() => frames.some((f) => f.includes('(global)')));
  const frame = lastFrame() ?? '';
  assert.equal(frame.includes('default (global) —'), false);
  assert.ok(frame.includes('> compact'));
});
