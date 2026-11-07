import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipMatchLine, grepTool, MAX_LINE_CHARS } from '../tools/grep.js';
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

test('a huge matching line is clipped to the part around the match, not returned whole', async () => {
  // Found 2026-11-06 on the VS Code source: a 1.38 MB single-line test-data file put the whole
  // line into a grep result (1,380,390 chars for 8 matches).
  const dir = await mkdtemp(join(tmpdir(), 'o4c-grepclip-'));
  try {
    const huge = 'x'.repeat(500_000) + 'needleFn(1)' + 'y'.repeat(500_000);
    await writeFile(join(dir, 'data.ts'), `${huge}\n`);
    await writeFile(join(dir, 'real.md'), 'call needleFn here\n');
    const out = await grepTool.execute({ pattern: 'needleFn', path: dir });
    assert.ok(out.length < 1000, `result is ${out.length} chars`);
    assert.match(out, /…x+needleFn\(1\)y+… \[line is 1,000,011 chars, clipped\]/);
    assert.match(out, /real\.md:1: call needleFn here/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clipMatchLine keeps short lines whole and clips at either end only where it cut', () => {
  const short = 'a'.repeat(MAX_LINE_CHARS);
  assert.equal(clipMatchLine(short, /a/), short);
  const atStart = 'hit' + 'z'.repeat(1000);
  const clipped = clipMatchLine(atStart, /hit/);
  assert.ok(clipped.startsWith('hitz'), 'no leading … when the window starts at 0');
  assert.match(clipped, /z… \[line is 1,003 chars, clipped\]$/);
});
