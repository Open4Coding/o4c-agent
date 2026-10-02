import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../ui/slashCommand.js';
import { MODES } from '../ui/modePolicy.js';
import { sessionViewRows } from '../ui/SessionViewPicker.js';
import { MARKER_WIDTH } from '../ui/SelectList.js';

// The rule for every dropdown / slash-choice window (also written in CLAUDE.md): a row's description is 1-3
// lines at a 100-column terminal, 3 only in extreme cases. Rows hang MARKER_WIDTH cells in, and the list has a
// border and one cell of padding on each side, so the text column is cols - 4 - MARKER_WIDTH wide.
const REFERENCE_COLS = 100;
const MAX_LINES = 3;
const TEXT_WIDTH = REFERENCE_COLS - 4 - MARKER_WIDTH;

/** Greedy word wrap, the way a terminal wraps a row: a word that does not fit starts the next line. */
function wrappedLines(text: string, width: number): number {
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    const need = used === 0 ? word.length : used + 1 + word.length;
    if (need <= width) {
      used = need;
    } else {
      lines++;
      used = word.length;
    }
  }
  return lines;
}

test('every slash command row (name - description) stays within 3 lines at 100 columns', () => {
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])].join(', ');
    const row = names + ' — ' + c.description;
    assert.ok(
      wrappedLines(row, TEXT_WIDTH) <= MAX_LINES,
      c.name + ' wraps to ' + wrappedLines(row, TEXT_WIDTH) + ' lines (' + row.length + ' chars) - shorten its description',
    );
  }
});

test('every /mode row stays within 3 lines at 100 columns', () => {
  for (const m of MODES) {
    const row = m.label + ' — ' + m.description + ' (current)';
    assert.ok(wrappedLines(row, TEXT_WIDTH) <= MAX_LINES, m.mode + ' wraps to ' + wrappedLines(row, TEXT_WIDTH) + ' lines');
  }
});

test('every session view row stays within 3 lines at 100 columns', () => {
  for (const scope of ['local', 'global'] as const) {
    for (const r of sessionViewRows(scope, 'compact')) {
      const row = r.label + ' — ' + r.description + ' (current)';
      assert.ok(wrappedLines(row, TEXT_WIDTH) <= MAX_LINES, scope + ' ' + r.choice + ' wraps to ' + wrappedLines(row, TEXT_WIDTH) + ' lines');
    }
  }
});

test('the wrap counter itself is right: a 94-character row is one line, 95 is two, and long words move down whole', () => {
  assert.equal(wrappedLines('x'.repeat(TEXT_WIDTH), TEXT_WIDTH), 1);
  assert.equal(wrappedLines('x'.repeat(TEXT_WIDTH) + ' y', TEXT_WIDTH), 2);
  assert.equal(wrappedLines('aaa bbb', 5), 2);
});

// ConfirmDialog's two fixed one-word rows (No / Yes) are not a list that can wrap, so they draw their own marker.
const OWN_MARKER_ALLOWED = ['ConfirmDialog.tsx'];

test('no picker draws its own "> " marker - SelectList owns the marker column, so wrapped rows always hang in', () => {
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
  const offenders = readdirSync(uiDir)
    .filter((f) => f.endsWith('.tsx') && f !== 'SelectList.tsx' && !OWN_MARKER_ALLOWED.includes(f))
    .filter((f) => /\?\s*'> '\s*:\s*' {2}'/.test(readFileSync(join(uiDir, f), 'utf-8')));
  assert.deepEqual(offenders, [], 'draw the row content only; SelectList draws the marker: ' + offenders.join(', '));
});
