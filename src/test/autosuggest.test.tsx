import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../ui/InputBox.js';
import { cleanSuggestion, saveSuggestion, SUGGESTION_MAX_CHARS, suggestionPrompt, takeSuggestion } from '../ui/autosuggest.js';

/** Plan 0006 L2: autosuggest - the guess, its cleaning, the ghost row and right-arrow accept. */

const RIGHT = '\u001B[C';
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error('timed out waiting for ' + what);
}

test('cleanSuggestion keeps one plain line, and NONE means no suggestion', () => {
  assert.equal(cleanSuggestion('"Run the tests again"\n'), 'Run the tests again');
  assert.equal(cleanSuggestion('\n  User: now add a test for it  '), 'now add a test for it');
  assert.equal(cleanSuggestion('NONE'), undefined);
  assert.equal(cleanSuggestion('none.'), undefined);
  assert.equal(cleanSuggestion('   \n'), undefined);
  const long = cleanSuggestion('x'.repeat(500))!;
  assert.ok(long.length <= SUGGESTION_MAX_CHARS && long.endsWith('...'));
});

test('the prompt carries only the last exchange, clipped from the front', () => {
  const p = suggestionPrompt('fix the bug', `${'old '.repeat(2000)}the newest part`);
  assert.match(p, /User: fix the bug/);
  assert.match(p, /the newest part/, 'the end of a long reply is what is kept');
  assert.ok(p.length < 4500, `prompt stays small (${p.length} chars)`);
});

test('a suggestion survives the per-turn reload once: saved, taken, then gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-suggest-'));
  try {
    saveSuggestion('session/1', 'run the tests', dir);
    assert.equal(takeSuggestion('session/1', dir), 'run the tests');
    assert.equal(takeSuggestion('session/1', dir), undefined, 'read once');
    assert.equal(takeSuggestion(undefined, dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the empty box shows the suggestion with a marker and the accept hint; right-arrow takes it', async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    React.createElement(InputBox, { onSubmit: (v: string) => submitted.push(v), suggestion: 'run the tests' }),
  );
  try {
    await until(() => (lastFrame() ?? '').includes('› run the tests  (→ accept)'), 'the ghost row');
    stdin.write(RIGHT);
    await until(() => !(lastFrame() ?? '').includes('(→ accept)'), 'the hint to go once accepted');
    stdin.write('\r');
    await until(() => submitted.length === 1, 'submit');
    assert.deepEqual(submitted, ['run the tests']);
  } finally {
    unmount();
  }
});

test('typing hides the suggestion, and right-arrow then moves the cursor as usual', async () => {
  const { stdin, lastFrame, unmount } = render(
    React.createElement(InputBox, { onSubmit: () => {}, suggestion: 'run the tests' }),
  );
  try {
    await until(() => (lastFrame() ?? '').includes('(→ accept)'), 'the ghost row');
    stdin.write('h');
    await until(() => !(lastFrame() ?? '').includes('(→ accept)'), 'the ghost row to go');
    stdin.write(RIGHT);
    await tick();
    assert.ok(!(lastFrame() ?? '').includes('run the tests'), 'not inserted into a non-empty box');
  } finally {
    unmount();
  }
});
