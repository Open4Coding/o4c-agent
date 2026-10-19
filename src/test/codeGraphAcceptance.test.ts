import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { grade, rate, pct, type GradeCounts } from '../graph/grading.js';

/**
 * The guard on the acceptance measurement.
 *
 * `.docs/code-graph-acceptance.md` makes claims about how well the code graph resolves calls, and
 * those claims will be read later by someone deciding what to trust. This file re-derives every
 * figure in the document's guarded block from the stored counts in
 * `.docs/code-graph-acceptance.json`, and - the part that matters - rejects any percentage in
 * that block which the counts do **not** produce. A hand-edited number fails the suite.
 *
 * It exists because of a specific mistake rather than as a formality. Earlier in this project I
 * quoted a recall figure from the code-graph literature that was a single cell of a table whose
 * author explicitly forbade reading it that way; it propagated into a design document and a
 * memory file before being caught. A number in a document drifts from its source silently. This
 * makes it noisy instead.
 */

interface Cell {
  counts: GradeCounts;
  constructorsInCell: number;
  exactLine: number;
  sameFilePreferenceWon: number;
  sameFilePreferenceLost: number;
  crossFileWrong: number;
  missedByExtraction: number;
  missedByResolution: number;
  recoverableByCandidate: number;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docsDir = join(repoRoot, '.docs');

const report = JSON.parse(readFileSync(join(docsDir, 'code-graph-acceptance.json'), 'utf8')) as {
  generated: string;
  cells: Record<string, Cell>;
};
const markdown = readFileSync(join(docsDir, 'code-graph-acceptance.md'), 'utf8');

/** The cells, in the order the document's table lists them. */
const CELLS: ReadonlyArray<readonly [id: string, label: string]> = [
  ['o4c-agent / with tests', 'o4c-agent, with tests'],
  ['o4c-agent / without tests', 'o4c-agent, without tests'],
  ['repomix / with tests', 'repomix, with tests'],
  ['repomix / without tests', 'repomix, without tests'],
];

function cell(id: string): Cell {
  const found = report.cells[id];
  assert.ok(found, `the measurement has no cell "${id}" - re-run scripts/graph-grade.mjs`);
  return found;
}

function widened(c: Cell) {
  return rate(c.counts.truePositives, c.counts.oracleEdges + c.constructorsInCell);
}

function figuresBlock(): string {
  const start = markdown.indexOf('<!-- figures:start -->');
  const end = markdown.indexOf('<!-- figures:end -->');
  assert.ok(start >= 0 && end > start, 'the document must keep its guarded figures block');
  return markdown.slice(start, end);
}

// ------------------------------------------------------------------ the counts themselves

test('every cell is measured and its counts add up', () => {
  assert.equal(Object.keys(report.cells).length, CELLS.length, 'four cells, no more and no fewer');
  for (const [id] of CELLS) {
    // grade() throws when the buckets do not partition, so this is the partition check too.
    const g = grade(cell(id).counts);
    assert.ok(g.precision.trials > 0, `${id} graded nothing`);
    assert.ok(g.recall.trials > 0, `${id} had no oracle edges`);
  }
});

test('the document is stamped with the date the counts were generated', () => {
  assert.match(report.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    markdown.includes(`Measured ${report.generated}`),
    `the document should say "Measured ${report.generated}"`,
  );
});

// ------------------------------------------------------------------ the published table

test('each table row is exactly what the stored counts produce', () => {
  const block = figuresBlock();

  for (const [id, label] of CELLS) {
    const c = cell(id);
    const g = grade(c.counts);
    const w = widened(c);

    // Reconstructed in full rather than checked field by field: one assertion that covers every
    // figure in the row, and that fails if any single digit was edited by hand.
    const row =
      `| ${label} ` +
      `| **${pct(g.precision.value)}** (${g.precision.successes}/${g.precision.trials}, ` +
      `95% CI ${pct(g.precision.interval.lower)}-${pct(g.precision.interval.upper)}) ` +
      `| **${pct(g.recall.value)}** (${g.recall.successes}/${g.recall.trials}, ` +
      `95% CI ${pct(g.recall.interval.lower)}-${pct(g.recall.interval.upper)}) ` +
      `| ${pct(w.value)} (${w.successes}/${w.trials}) ` +
      `| ${g.f1.toFixed(3)} |`;

    assert.ok(
      block.includes(row),
      `the row for "${label}" should read:\n  ${row}\nbut the document's figures block does not contain it`,
    );
  }
});

test('the line-number agreement figures are the measured ones', () => {
  const block = figuresBlock();
  // Checked one at a time rather than as a joined sentence, so reflowing the paragraph does not
  // fail the test. The allow-list assertion below is what stops an extra figure sneaking in.
  for (const [id, label] of CELLS) {
    const c = cell(id);
    const r = rate(c.exactLine, c.counts.truePositives);
    const quoted = `${pct(r.value)} (${r.successes}/${r.trials})`;
    assert.ok(block.includes(quoted), `${label} line agreement should be quoted as "${quoted}"`);
  }
});

test('no percentage in the figures block is one the counts do not produce', () => {
  // Everything above checks that the expected figures are PRESENT; this checks that nothing else
  // is, so a stale number left behind after a re-measurement cannot sit in the block unnoticed.
  //
  // Its limit, verified rather than assumed: the allow-list is pooled across cells, so a figure
  // that is wrong for its own row but happens to be right for another row passes this test. Both
  // were tried - swapping one cell's recall for another's CI bound slips past here and is caught
  // by the row reconstruction above, which is why both assertions exist.
  const allowed = new Set<string>();
  for (const [id] of CELLS) {
    const c = cell(id);
    const g = grade(c.counts);
    for (const r of [g.precision, g.recall, widened(c), rate(c.exactLine, c.counts.truePositives)]) {
      allowed.add(pct(r.value));
      allowed.add(pct(r.interval.lower));
      allowed.add(pct(r.interval.upper));
    }
  }

  const found = figuresBlock().match(/\d+\.\d%/g) ?? [];
  assert.ok(found.length >= 4 * 7, `expected the block to carry the figures, found ${found.length}`);
  for (const token of found) {
    assert.ok(
      allowed.has(token),
      `"${token}" appears in the figures block but no stored count produces it. ` +
        `Allowed: ${[...allowed].sort().join(' ')}`,
    );
  }
});

// ------------------------------------------------------------------ claims made in the prose

test('the same-file preference verdict matches the counts behind it', () => {
  // The document says the heuristic was right 1,782 times and wrong 19, and keeps it on that
  // basis. If a later change moves those numbers, the recommendation has to be revisited rather
  // than left standing on figures that no longer hold.
  let won = 0;
  let lost = 0;
  for (const [id] of CELLS) {
    won += cell(id).sameFilePreferenceWon;
    lost += cell(id).sameFilePreferenceLost;
  }
  assert.ok(
    markdown.includes(`right ${won.toLocaleString('en-US')} times and wrong ${lost}`),
    `the document should say "right ${won.toLocaleString('en-US')} times and wrong ${lost}"`,
  );
  assert.ok(won > lost * 10, 'the recommendation to keep the heuristic depends on this ratio');
});

test('the claim that nothing is lost to extraction is still true', () => {
  for (const [id] of CELLS) {
    assert.equal(
      cell(id).missedByExtraction,
      0,
      `${id} lost an oracle edge at a call site the graph never saw - the document claims ` +
        'this no longer happens, and that claim is now false',
    );
  }
  assert.ok(markdown.includes('`missedByExtraction` is 0 in all four cells'));
});

test('the "declined rather than failed to see" claim is the measured proportion', () => {
  const c = cell('o4c-agent / with tests');
  const share = rate(c.recoverableByCandidate, c.missedByResolution);
  assert.ok(
    markdown.includes(
      `${c.missedByResolution} misses in the largest cell, ${c.recoverableByCandidate} (${pct(share.value)})`,
    ),
    `the document should quote ${c.recoverableByCandidate}/${c.missedByResolution} = ${pct(share.value)}`,
  );
  // The conclusion drawn from it - that import-aware disambiguation is the next real gain - only
  // follows while most misses are declined choices rather than unseen call sites.
  assert.ok(share.value > 0.5, 'ambiguity, not blindness, has to be the dominant cause');
});

test('the excluded-universe table quotes the oracle diagnostics', () => {
  const o4c = (report.cells['o4c-agent / with tests'] as Cell & {
    oracleDiagnostics: Record<string, number>;
  }).oracleDiagnostics;
  const repomix = (report.cells['repomix / with tests'] as Cell & {
    oracleDiagnostics: Record<string, number>;
  }).oracleDiagnostics;

  for (const [field, label] of [
    ['newExpressions', 'constructor calls'],
    ['unsupportedShape', 'uncaptured call shapes'],
    ['outOfRepo', 'out-of-repo targets'],
  ] as const) {
    const quoted = `${o4c[field].toLocaleString('en-US')} / ${repomix[field].toLocaleString('en-US')}`;
    assert.ok(
      markdown.includes(quoted),
      `the exclusions table should give ${label} as "${quoted}"`,
    );
  }
});
