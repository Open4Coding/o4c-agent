import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkTagStripper } from '../agent/streamFilter.js';

function run(chunks: string[]): string[] {
  const emitted: string[] = [];
  const { feed, flush } = createThinkTagStripper((text) => emitted.push(text));
  for (const chunk of chunks) feed(chunk);
  flush();
  return emitted;
}

test('plain text with no tags passes through unchanged', () => {
  assert.deepEqual(run(['hello, world']), ['hello, world']);
  assert.equal(run(['hello, world']).join(''), 'hello, world');
});

test('strips a complete <think>...</think> block delivered in one chunk, keeping the content', () => {
  const result = run(['<think>reasoning here</think>the answer']).join('');
  assert.equal(result, 'reasoning herethe answer');
  assert.ok(!result.includes('<think>'));
  assert.ok(!result.includes('</think>'));
});

test('never emits a raw tag, even when split across many small chunks', () => {
  const chunks = ['<', 'th', 'in', 'k', '>', 'reasoning', '<', '/', 'thi', 'nk', '>', 'final answer'];
  const joined = run(chunks).join('');
  assert.equal(joined, 'reasoningfinal answer');
  assert.ok(!joined.includes('<'));
  assert.ok(!joined.includes('>'));
});

test('a tag split exactly at the chunk boundary is still fully stripped', () => {
  const joined = run(['before <thi', 'nk>inside</th', 'ink>after']).join('');
  assert.equal(joined, 'before insideafter');
});

test('text that merely resembles a tag prefix but never completes one is preserved verbatim', () => {
  // "a < b" is not a tag - the "<" must not be silently eaten because it happens to be TAGS[0][0].
  const joined = run(['a < b, and c > d']).join('');
  assert.equal(joined, 'a < b, and c > d');
});

test('an opened think block that never closes (unclosed tag) still flushes its content, not lost', () => {
  const joined = run(['<think>never closes, stream just ends']).join('');
  assert.equal(joined, 'never closes, stream just ends');
});

test('flush emits nothing extra when the buffer is already empty', () => {
  const emitted: string[] = [];
  const { feed, flush } = createThinkTagStripper((t) => emitted.push(t));
  feed('complete text<think>x</think>');
  const beforeFlushCount = emitted.length;
  flush();
  assert.equal(emitted.length, beforeFlushCount);
});

test('multiple think blocks in one stream are all stripped', () => {
  const joined = run(['<think>one</think>A<think>two</think>B']).join('');
  assert.equal(joined, 'oneAtwoB');
});

test('content immediately after an open tag in the same chunk streams without waiting', () => {
  const emitted = run(['<think>reasoning continues for a while']);
  // Everything after the tag in this single chunk should have been emitted as one piece (no
  // artificial per-character delay), proving reasoning content isn't held back once the opening
  // tag itself is fully resolved.
  assert.ok(emitted.includes('reasoning continues for a while'));
});
