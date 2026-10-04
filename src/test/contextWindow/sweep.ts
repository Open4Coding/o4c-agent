// Phase-2 sweep, run by hand: seeded random cases across the window matrix, each failure shrunk.
//
//   npx tsx src/test/contextWindow/sweep.ts
//
// Environment (all optional):
//   O4C_FUZZ_START    first seed (default 1)
//   O4C_FUZZ_SEEDS    how many seeds (default 40)
//   O4C_CTX_WINDOWS   comma list of windows (default 4096,...,229376)
//   O4C_FUZZ_OUT      where failing cases are written (default tmp.tmp/fuzz-failures.json next to the package)
//
// Reproduce one failure: set O4C_FUZZ_START to its seed, O4C_FUZZ_SEEDS=1, O4C_CTX_WINDOWS to its window.

import { writeFileSync } from 'node:fs';
import { DEFAULT_WINDOWS } from './scenarios.js';
import { caseSize, firstViolation, generateCase, shrink, type FuzzCase } from './fuzz.js';

const start = Number(process.env.O4C_FUZZ_START ?? 1);
const seedCount = Number(process.env.O4C_FUZZ_SEEDS ?? 40);
const windows = process.env.O4C_CTX_WINDOWS
  ? process.env.O4C_CTX_WINDOWS.split(',').map((w) => Number(w.trim()))
  : DEFAULT_WINDOWS;
const outPath = process.env.O4C_FUZZ_OUT ?? 'tmp.tmp/fuzz-failures.json';

interface Failure {
  seed: number;
  window: number;
  invariant: string;
  originalSize: number;
  minimal: FuzzCase;
}

const failures: Failure[] = [];
let runs = 0;

for (let seed = start; seed < start + seedCount; seed++) {
  for (const window of windows) {
    runs += 1;
    const original = generateCase(seed, window);
    const invariant = await firstViolation(original);
    if (invariant === undefined) continue;
    const minimal = await shrink(original, async (c) => (await firstViolation(c)) === invariant);
    failures.push({ seed, window, invariant, originalSize: caseSize(original), minimal });
    console.log(
      `FAIL seed=${seed} window=${window} invariant=${invariant} ` +
        `size ${caseSize(original)} -> ${caseSize(minimal)} (${minimal.turns.length} turns, ` +
        `${minimal.turns.reduce((n, t) => n + t.rounds.length, 0)} rounds)`,
    );
  }
}

writeFileSync(outPath, JSON.stringify(failures, null, 2));
const byInvariant = new Map<string, number>();
for (const f of failures) byInvariant.set(f.invariant, (byInvariant.get(f.invariant) ?? 0) + 1);
console.log(`\nruns=${runs} failures=${failures.length} written=${outPath}`);
for (const [invariant, count] of byInvariant) console.log(`  ${invariant}: ${count}`);
