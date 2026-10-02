import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../ui/slashCommand.js';
import { MODES } from '../ui/modePolicy.js';
import { sessionViewRows } from '../ui/SessionViewPicker.js';
import { CONTINUATION_INDENT, LIST_CHROME_WIDTH, MARKER_WIDTH, wrapRow } from '../ui/SelectList.js';

// The rule for every dropdown / slash-choice window (also written in CLAUDE.md): a row's description is 1-3
// lines at a 100-column terminal, 3 only in extreme cases. Uses the list's own wrapRow and widths, so the test
// measures exactly what the list draws.
const REFERENCE_COLS = 100;
const MAX_LINES = 3;
const INNER = REFERENCE_COLS - LIST_CHROME_WIDTH;

function wrappedLines(text: string): number {
  return wrapRow(text, INNER - MARKER_WIDTH, INNER - CONTINUATION_INDENT).length;
}

test('every slash command row (name - description) stays within 3 lines at 100 columns', () => {
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])].join(', ');
    const row = names + ' — ' + c.description;
    assert.ok(
      wrappedLines(row) <= MAX_LINES,
      c.name + ' wraps to ' + wrappedLines(row) + ' lines (' + row.length + ' chars) - shorten its description',
    );
  }
});

test('every /mode row stays within 3 lines at 100 columns', () => {
  for (const m of MODES) {
    const row = m.label + ' — ' + m.description + ' (current)';
    assert.ok(wrappedLines(row) <= MAX_LINES, m.mode + ' wraps to ' + wrappedLines(row) + ' lines');
  }
});

test('every session view row stays within 3 lines at 100 columns', () => {
  for (const scope of ['local', 'global'] as const) {
    for (const r of sessionViewRows(scope, 'compact')) {
      const row = r.label + ' — ' + r.description + ' (current)';
      assert.ok(wrappedLines(row) <= MAX_LINES, scope + ' ' + r.choice + ' wraps to ' + wrappedLines(row) + ' lines');
    }
  }
});

test('the 100-column budget matches the list: 94 cells on the first line, 92 on later lines', () => {
  assert.equal(INNER - MARKER_WIDTH, 94);
  assert.equal(INNER - CONTINUATION_INDENT, 92);
  assert.equal(wrappedLines('x'.repeat(94)), 1);
  assert.equal(wrappedLines('x'.repeat(95)), 2);
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
