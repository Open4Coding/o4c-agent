import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from '../tools/grep.js';
import { groupGrepByDefinition } from '../tools/grepGroup.js';

/** Plan 0006 B13: grep matches grouped by enclosing definition; broad searches lead with counts. */

const SRC = `import { pi } from './pi';

export class Shape {
  area(): number {
    return pi * this.r * this.r;
  }
}

export function perimeter(r: number) {
  return 2 * pi * r;
}
`;

test('matches are grouped under the innermost definition, path once, top level marked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-grepgroup-'));
  try {
    await writeFile(join(dir, 'shape.ts'), SRC);
    await writeFile(join(dir, 'notes.md'), 'pi is about 3.14\n');
    const out = await grepTool.execute({ pattern: 'pi', path: dir });
    assert.equal(
      out,
      [
        'notes.md:1: pi is about 3.14',
        'shape.ts',
        '  (top level):',
        "    1: import { pi } from './pi';",
        '  area (method, 4-6):',
        '    5: return pi * this.r * this.r;',
        '  perimeter (function, 9-11):',
        '    10: return 2 * pi * r;',
      ].join('\n'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lines that are not matches pass through, and an output with no matches is untouched', () => {
  assert.equal(groupGrepByDefinition('No matches for "x" under ".".', () => []), 'No matches for "x" under ".".');
  const out = groupGrepByDefinition('a.ts:3: x\nnote\na.ts:9: y', () => [{ name: 'f', kind: 'function', line: 1, endLine: 5 }]);
  assert.equal(out, 'a.ts\n  f (function, 1-5):\n    3: x\nnote\na.ts\n  (top level):\n    9: y');
});

test('a broad search leads with per-file counts and shows only the first lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-grepbroad-'));
  try {
    for (let f = 0; f < 20; f++) await writeFile(join(dir, `f${String(f).padStart(2, '0')}.txt`), 'hit\n'.repeat(f === 3 ? 9 : 2));
    const out = await grepTool.execute({ pattern: 'hit', path: dir });
    const lines = out.split('\n');
    assert.equal(lines[0], '47 matches in 20 files - narrow with "path" or "glob" to see them all. Matches per file:');
    assert.equal(lines[1], '  f03.txt (9)');
    assert.equal(lines[2], '  f00.txt (2)');
    assert.ok(lines.includes('First 40 matches:'));
    assert.equal(lines.length, 1 + 20 + 1 + 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
