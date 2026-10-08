import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TOOL_OUTPUT_TOKENS,
  MAX_USER_INPUT_TOKENS,
  MIN_TOOL_OUTPUT_TOKENS,
  MIN_USER_INPUT_TOKENS,
  maxToolOutputChars,
  maxToolOutputTokens,
  maxUserInputChars,
  maxUserInputTokens,
  spillToolOutput,
  truncateToolOutput,
  truncateUserInput,
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

test('the user-input budget scales with the window, clamped at both ends', () => {
  // The window is not a constant: llama.cpp divides n_ctx across --parallel slots and o4c re-probes
  // the per-slot size at every launch, so these are the real windows a session can land in.
  assert.equal(maxUserInputTokens(229_376), 22_938); // --parallel 1, genuinely scaled
  assert.equal(maxUserInputTokens(114_688), 11_469); // --parallel 2
  assert.equal(maxUserInputTokens(57_344), 5_734); // --parallel 4
  assert.equal(maxUserInputTokens(14_336), 1_434); // --parallel 16
  assert.equal(maxUserInputTokens(4_000), MIN_USER_INPUT_TOKENS); // 400 -> lifted to the floor
  assert.equal(maxUserInputTokens(400_000), MAX_USER_INPUT_TOKENS); // 40,000 -> held at the ceiling
  assert.equal(maxUserInputTokens(undefined), MAX_USER_INPUT_TOKENS); // unknown window is still bounded
});

test('a real task prompt is nowhere near the budget, at any concurrency', () => {
  // Measured from the actual tier-3 test prompt (3,172 chars). The cap exists for a pasted
  // megabyte, and must never touch an ordinary prompt - including on the smallest window a
  // --parallel 16 server would hand out.
  const realPrompt = 'x'.repeat(3_172);
  for (const window of [14_336, 57_344, 114_688, 229_376]) {
    assert.equal(truncateUserInput(realPrompt, maxUserInputChars(window)).truncated, false, `window ${window}`);
  }
});

test('a user message within budget is returned byte-identical, with no marker', () => {
  const msg = 'write me a tetris clone\nin one file';
  const r = truncateUserInput(msg, maxUserInputChars(229_376));
  assert.equal(r.text, msg);
  assert.equal(r.truncated, false);
  assert.equal(r.originalChars, msg.length);
});

test('an oversized user message keeps the head, where the instructions live', () => {
  const head = 'RULES: only write to C:\\tmp.tmp, never touch D:\\AngelCode\n';
  const tail = '\nENDS HERE: report when done';
  const msg = head + 'filler line\n'.repeat(200_000) + tail;
  const maxChars = maxUserInputChars(57_344);
  const r = truncateUserInput(msg, maxChars, 'C:\\tmp.tmp\\.o4c\\tool-output\\spill.txt');

  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= maxChars, `${r.text.length} > ${maxChars}`);
  assert.equal(r.originalChars, msg.length);
  assert.ok(r.text.startsWith('RULES:'), 'the head must survive - it carries the task rules');
  assert.ok(r.text.endsWith(tail), 'the tail must survive too');
  assert.ok(r.text.includes('o4c truncated this message'), 'says it was a message, not output');
  assert.ok(r.text.includes('Full message:'), 'names the spill file');
  assert.ok(!r.text.includes('narrow the command'), 'that advice is for tool output, not a user message');
});

test('an oversized user message with no spill says so instead of naming a path', () => {
  const r = truncateUserInput('y'.repeat(200_000), maxUserInputChars(14_336));
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('not recoverable from here'), r.text.slice(0, 200));
  assert.ok(!r.text.includes('Full message:'));
});

test('the user-input char budget stays the exact inverse of estimateTextTokens', () => {
  for (const window of [4_000, 14_336, 57_344, 114_688, 229_376]) {
    const filled = 'x'.repeat(maxUserInputChars(window));
    assert.equal(estimateTextTokens(filled), maxUserInputTokens(window));
  }
});
