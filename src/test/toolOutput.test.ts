import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TOOL_OUTPUT_TOKENS,
  MIN_TOOL_OUTPUT_TOKENS,
  maxToolOutputChars,
  maxToolOutputTokens,
  spillToolOutput,
  truncateToolOutput,
} from '../tools/toolOutput.js';
import { estimateTextTokens } from '../agent/contextEntry.js';

test('the budget scales with the window, clamped at both ends', () => {
  assert.equal(maxToolOutputTokens(229_376), MAX_TOOL_OUTPUT_TOKENS); // 22,938 -> capped at 10,000
  assert.equal(maxToolOutputTokens(114_688), MAX_TOOL_OUTPUT_TOKENS); // --parallel 2
  assert.equal(maxToolOutputTokens(57_344), 5_734); // --parallel 4, genuinely scaled
  assert.equal(maxToolOutputTokens(16_000), 1_600);
  assert.equal(maxToolOutputTokens(4_000), MIN_TOOL_OUTPUT_TOKENS); // 400 -> lifted to the floor
});

test('the char budget stays the exact inverse of estimateTextTokens, so the two can never drift', () => {
  for (const window of [4_000, 16_000, 57_344, 114_688, 229_376]) {
    const filled = 'x'.repeat(maxToolOutputChars(window));
    assert.equal(estimateTextTokens(filled), maxToolOutputTokens(window));
  }
});

test('output within budget is returned byte-identical, with no marker', () => {
  const text = 'line one\nline two\n';
  const result = truncateToolOutput(text, 40_000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
  assert.equal(result.originalChars, text.length);
});

test('output exactly at the budget is not truncated', () => {
  const text = 'x'.repeat(4_000);
  const result = truncateToolOutput(text, 4_000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
});

test('one char over the budget truncates, and the result still fits the budget', () => {
  const text = 'x'.repeat(4_001);
  const result = truncateToolOutput(text, 4_000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 4_000, `got ${result.text.length}`);
});

test('an oversized result keeps both the head and the tail, and reports the real size', () => {
  const body = Array.from({ length: 200_000 }, (_, i) => `D:/AngelCode/file-${i}.txt`).join('\n');
  const text = `FIRST-LINE-MARKER\n${body}\nLAST-LINE-MARKER`;
  const spillPath = join('C:', 'proj', '.o4c', 'tool-output', 'spill.txt');
  const result = truncateToolOutput(text, 40_000, spillPath);

  assert.equal(result.truncated, true);
  assert.equal(result.originalChars, text.length);
  assert.ok(result.text.length <= 40_000, `got ${result.text.length}`);
  assert.ok(result.text.startsWith('FIRST-LINE-MARKER'), 'head is kept');
  assert.ok(result.text.endsWith('LAST-LINE-MARKER'), 'tail is kept');
  assert.match(result.text, /\[o4c truncated this output: [\d,]+ chars/);
  assert.match(result.text, /~[\d,]+ tokens/);
  assert.ok(result.text.includes(`Full output: ${spillPath}.`), 'names the spill file');
  assert.match(result.text, /read_file offset\/limit/);
});

test('the real 11MB dir-listing shape is bounded to the 229K budget', () => {
  // The exact failure from 2026-10-06: one `dir /s /b` tool result of 11,370,857 chars, about 15x a
  // 229,376-token window, on the second tool call of the session.
  const sep = String.fromCharCode(92);
  const line = `D:${sep}AngelCode${sep}research${sep}agentic-frameworks${sep}x.py\n`;
  const text = `Command failed: stdout maxBuffer length exceeded\n${line.repeat(250_000)}`;
  assert.ok(text.length > 11_000_000, `fixture is realistically huge, got ${text.length}`);

  const result = truncateToolOutput(text, maxToolOutputChars(229_376));
  assert.ok(result.text.length <= 40_000, `got ${result.text.length}`);
  assert.ok(estimateTextTokens(result.text) <= MAX_TOOL_OUTPUT_TOKENS);
  assert.ok(
    result.text.startsWith('Command failed: stdout maxBuffer length exceeded'),
    'the error line itself survives, so the model learns why it was cut',
  );
});

test('no newline anywhere still truncates to budget rather than discarding a side', () => {
  const result = truncateToolOutput('x'.repeat(100_000), 4_000);
  assert.ok(result.text.length <= 4_000);
  assert.ok(result.text.startsWith('xxx'));
  assert.ok(result.text.endsWith('xxx'));
});

test('a very long spill path cannot push the result past the budget', () => {
  const longPath = `C:${'/nested'.repeat(60)}/spill.txt`;
  const result = truncateToolOutput('y'.repeat(50_000), 4_000, longPath);
  assert.ok(result.text.length <= 4_000, `got ${result.text.length}`);
});

test('spillToolOutput writes the full text and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-spill-'));
  const text = 'z'.repeat(5_000);
  const path = await spillToolOutput(dir, 'run_shell', text);
  assert.ok(path, 'returns a path');
  assert.equal(await readFile(path, 'utf-8'), text);
  assert.equal((await readdir(dir)).length, 1);
});

test('spillToolOutput never throws - no directory means no path, not a failed turn', async () => {
  assert.equal(await spillToolOutput(undefined, 'run_shell', 'anything'), undefined);
  // A path that is a file, not a directory, must degrade to undefined rather than reject.
  const dir = await mkdtemp(join(tmpdir(), 'o4c-spill-'));
  const filePath = await spillToolOutput(dir, 'run_shell', 'first');
  assert.ok(filePath);
  assert.equal(await spillToolOutput(filePath, 'run_shell', 'second'), undefined);
});

test('a tool name with path characters cannot escape the spill directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-spill-'));
  const path = await spillToolOutput(dir, '../../etc/passwd', 'x');
  assert.ok(path);
  assert.ok(path.startsWith(dir), `${path} stayed inside ${dir}`);
});
