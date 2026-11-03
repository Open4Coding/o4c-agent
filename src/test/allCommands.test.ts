import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allCommands, matchCommands, pinnedCommands, setPinnedCommands } from '../ui/slashCommand.js';

/** Plan 0006 E1: /all shows every command; pinned hidden commands join the bare / list. */

test('/all includes hidden commands; the bare list does not, until one is pinned', () => {
  const all = allCommands().map((c) => c.name);
  assert.ok(all.includes('/set-shell') && all.includes('/memory-edit'), 'hidden ones are there');
  assert.deepEqual(all, [...all].sort((a, b) => a.localeCompare(b)));
  assert.equal(matchCommands('/').some((c) => c.name === '/set-shell'), false);
  setPinnedCommands(['/set-shell', 42]);
  try {
    assert.deepEqual(pinnedCommands(), ['/set-shell']);
    assert.equal(matchCommands('/').some((c) => c.name === '/set-shell'), true);
    assert.equal(matchCommands('/se').some((c) => c.name === '/set-shell'), true);
  } finally {
    setPinnedCommands(undefined);
  }
  assert.equal(matchCommands('/').some((c) => c.name === '/set-shell'), false);
});
