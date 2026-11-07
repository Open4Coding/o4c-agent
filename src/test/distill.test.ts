import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distillToolOutput } from '../tools/distill.js';
import { truncateToolOutput } from '../tools/toolOutput.js';

/** Plan 0006 B15: an oversized tool result keeps what matters - repetition collapsed, errors first. */

function failingRun(): string {
  const lines: string[] = ['TAP version 13'];
  for (let i = 1; i <= 5000; i++) {
    if (i === 1234 || i === 3000 || i === 4321) {
      lines.push(`not ok ${i} - parses case ${i}`, `  ---`, `  at parse (src/parser.js:${i % 97}:7)`, `  expected: ${i}`, `  actual: ${i + 1}`, `  ...`);
    } else {
      lines.push(`ok ${i} - parses case ${i} with a fairly long description of what is being checked`);
    }
  }
  lines.push('# tests 5000', '# pass 4997', '# fail 3');
  return lines.join('\n');
}

test('a 5,000-line failing test run keeps every failure and its file:line under the cap', () => {
  const text = failingRun();
  const result = truncateToolOutput(text, 16_000, 'C:/p/.o4c/tool-output/run.txt');
  assert.ok(result.text.length <= 16_000, `got ${result.text.length}`);
  for (const n of [1234, 3000, 4321]) {
    assert.match(result.text, new RegExp(`not ok ${n} - parses case ${n}`));
    assert.match(result.text, new RegExp(`src/parser\\.js:${n % 97}:7`));
  }
  assert.match(result.text, /# fail 3/);
  assert.match(result.text, /Full output: C:\/p\/\.o4c\/tool-output\/run\.txt\./);
  assert.ok(result.text.startsWith('TAP version 13\n[o4c condensed this output'));
});

test('when repetition alone does not fit, error regions are kept with their line numbers', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `step ${i}: ${'z'.repeat((i * 7) % 50)} done ${'abcdefghij'[i % 10]}`);
  lines[1500] = 'Error: connection refused at src/net/client.ts:88';
  const text = lines.join('\n');
  const result = distillToolOutput(text, 4_000)!;
  assert.ok(result && result.text.length <= 4_000);
  assert.match(result.text, /--- lines 1500-1503 ---\n.*\nError: connection refused at src\/net\/client\.ts:88/);
});

test('nothing to work with: falls back (undefined), so head+tail applies', () => {
  assert.equal(distillToolOutput('x'.repeat(100_000), 4_000), undefined);
  const varied = Array.from({ length: 2000 }, (_, i) => `entry ${'qwertyuiop'[i % 10]}${'asdfghjkl'[i % 9]} value`).join('\n');
  assert.equal(distillToolOutput(varied.replace(/\d/g, ''), 4_000)?.text.includes('condensed') ?? false, false);
});

test('an overlong line among ordinary ones is clipped first, and the ordinary lines are all kept', () => {
  // Found 2026-11-06 on the VS Code source: one 1.38 MB line in an 8-hit grep result was treated
  // as a log, and the condenser kept "lines that look like errors" instead of the hits.
  const hits = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts:${i + 10}: ensureThing(error);`);
  const text = [hits[0], `src/data.ts:1: ${'q'.repeat(1_380_000)}`, ...hits.slice(1)].join('\n');
  const out = distillToolOutput(text, 40_000);
  assert.ok(out, 'condensed');
  assert.ok(out.text.length < 3_000, `${out.text.length} chars`);
  assert.match(out.text, /1 overlong line\(s\) clipped/);
  assert.match(out.text, /\[line 2: 1,380,015 chars, clipped\]/);
  for (const hit of hits) assert.ok(out.text.includes(hit), `kept: ${hit}`);
});
