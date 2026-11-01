import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FULL_ENTRY_CAP_CHARS,
  TOOL_CALL_PREVIEW_CHARS,
  WRITE_FILE_PREVIEW_LINES,
  WRITE_FILE_PREVIEW_LINE_CHARS,
  toolCallText,
} from '../ui/formatEvent.js';
import { fencedSegments } from '../ui/codeFences.js';
import { formatMessage } from '../ui/formatMessage.js';

/**
 * Item 42: a `write_file` call is shown as its path and the file as real lines in a fenced block,
 * not as one escaped JSON string. Every other tool keeps the JSON.
 */

const html = ['<!DOCTYPE html>', '<html lang="en">', '<head>', '<title>Tetris</title>', '</head>', '</html>', ''].join('\n');

test('full view: path line, then the file as real lines in a fence named after the extension', () => {
  const text = toolCallText('write_file', { path: 'tetris.html', content: html }, 'full');
  assert.deepEqual(text.split('\n'), [
    'tetris.html (6 lines, 78 characters)',
    '```html',
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<title>Tetris</title>',
    '</head>',
    '</html>',
    '```',
  ]);
  assert.ok(!text.includes('\\n') && !text.includes('\\"'), 'no escape sequences');
});

test('the block is coloured: fencedSegments sees the fence and marks the file as code', () => {
  const segments = fencedSegments(toolCallText('write_file', { path: 'tetris.html', content: html }, 'full'));
  assert.ok(segments);
  const code = segments.filter((s) => s.kind === 'code').map((s) => s.text).join('');
  assert.ok(code.includes('<title>Tetris</title>'));
  assert.ok(segments.some((s) => s.kind === 'code' && s.scope), 'at least one span has a highlight scope');
  assert.equal(segments[0].kind, 'prose', 'the path line is not code');
});

test('compact view: first lines only, long lines clipped, a count of the rest', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(i === 0 ? 500 : 0)}`);
  const text = toolCallText('write_file', { path: 'a.ts', content: lines.join('\n') }, 'compact');
  const out = text.split('\n');
  assert.equal(out[0], 'a.ts (50 lines, 939 characters)');
  assert.equal(out[1], '```ts');
  assert.equal(out.length, 2 + WRITE_FILE_PREVIEW_LINES + 2);
  assert.equal(out[2].length, WRITE_FILE_PREVIEW_LINE_CHARS + 3);
  assert.equal(out[out.length - 1], `... (+${50 - WRITE_FILE_PREVIEW_LINES} more lines, full text in the session file)`);
});

test('a file containing a fence gets a longer one, so a Markdown file cannot close the block early', () => {
  const md = ['# Title', '```js', 'x()', '```', 'end'].join('\n');
  const text = toolCallText('write_file', { path: 'README.md', content: md }, 'full');
  const out = text.split('\n');
  assert.equal(out[1], '````md');
  assert.equal(out[out.length - 1], '````');
  const code = fencedSegments(text)!.filter((s) => s.kind === 'code').map((s) => s.text).join('');
  assert.ok(code.includes('end'), 'the last line of the file is still inside the block');
});

test('no extension: the file name is the fence info (Dockerfile, Makefile)', () => {
  assert.equal(toolCallText('write_file', { path: 'build/Dockerfile', content: 'FROM node' }, 'full').split('\n')[1], '```Dockerfile');
});

test('full view keeps the per-line safety cap, cut on a line boundary so the block still closes', () => {
  const line = 'y'.repeat(999);
  const content = Array.from({ length: Math.ceil(FULL_ENTRY_CAP_CHARS / 1000) + 10 }, () => line).join('\n');
  const out = toolCallText('write_file', { path: 'big.txt', content }, 'full').split('\n');
  assert.ok(out.join('\n').length < FULL_ENTRY_CAP_CHARS + 300);
  assert.equal(out[out.length - 2], '```');
  assert.match(out[out.length - 1], /^\.\.\. \(\+\d+ more lines, full text in the session file\)$/);
});

test('every other tool keeps the JSON, cut in compact as before', () => {
  const input = { command: 'x'.repeat(1000) };
  assert.equal(toolCallText('run_shell', input, 'full'), JSON.stringify(input));
  const compact = toolCallText('run_shell', input, 'compact');
  assert.equal(compact, `${JSON.stringify(input).slice(0, TOOL_CALL_PREVIEW_CHARS)}...`);
  assert.equal(toolCallText('write_file', { path: 'a' }, 'full'), '{"path":"a"}', 'malformed write_file input falls back');
});

test('/resume repaint: the id goes on the first line, and the file is shown the same way', () => {
  const [line] = formatMessage({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'write_file', input: { path: 'tetris.html', content: html } }] });
  const out = line.text.split('\n');
  assert.equal(out[0], '[tool] write_file');
  assert.equal(out[1], 'tetris.html (6 lines, 78 characters) id=c1');
  assert.equal(out[2], '```html');
});
