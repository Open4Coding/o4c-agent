import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FenceTracker, fencedSegments } from '../ui/codeFences.js';

/**
 * Item 9: code blocks in replies. The reply text is never changed - these tests check which lines
 * are code, which are fences, and that joining the segments gives the reply back.
 */

const reply = ['Here is the fix:', '', '```ts', 'const a = 1; /* one', 'two */', '```', 'Done.'].join('\n');

test('a finished reply splits into prose, fences and coloured code, and joins back unchanged', () => {
  const segments = fencedSegments(reply);
  assert.ok(segments);
  assert.equal(segments.map((s) => s.text).join(''), reply);
  assert.equal(segments.find((s) => s.text.startsWith('```ts'))?.kind, 'fence');
  assert.equal(segments.find((s) => s.text === 'const')?.scope, 'keyword');
  assert.equal(segments.find((s) => s.text.includes('two */'))?.scope, 'comment', 'a comment spans lines');
  assert.equal(segments.find((s) => s.text.startsWith('Done.'))?.kind, 'prose');
});

test('a reply with no fence is left alone', () => {
  assert.equal(fencedSegments('just prose, with `inline` code'), undefined);
});

test('a streamed reply is classified line by line, in order', () => {
  const tracker = new FenceTracker();
  const roles = reply.split('\n').map((line) => tracker.next(line).role);
  assert.deepEqual(roles, ['prose', 'prose', 'fence', 'code', 'code', 'fence', 'prose']);
});

test('the streamed and the finished paths colour a line the same way', () => {
  const tracker = new FenceTracker();
  const streamed = reply.split('\n').map((line) => tracker.next(line));
  const second = streamed[4];
  assert.equal(second.role, 'code');
  if (second.role === 'code') assert.equal(second.code[0].scope, 'comment');
});

test('a closing fence must match the opening one, and a reset forgets an open block', () => {
  const tracker = new FenceTracker();
  tracker.next('````md');
  assert.equal(tracker.next('```').role, 'code', 'three backticks do not close a four-backtick fence');
  assert.equal(tracker.next('````').role, 'fence');
  tracker.next('```');
  tracker.reset();
  assert.equal(tracker.next('plain').role, 'prose');
});

test('a fence with an unknown language still marks code, drawn plain', () => {
  const tracker = new FenceTracker();
  tracker.next('```nosuchlang');
  const line = tracker.next('x = 1');
  assert.equal(line.role, 'code');
  if (line.role === 'code') assert.deepEqual(line.code, [{ text: 'x = 1' }]);
});
