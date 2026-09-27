import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicMessages } from '../providers/anthropic.js';
import type { Message } from '../providers/types.js';

test('a plain assistant text message has no thinking block', () => {
  const messages: Message[] = [{ role: 'assistant', content: 'the answer' }];
  const [msg] = toAnthropicMessages(messages);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'the answer' }]);
});

test('a thinking turn prepends a thinking block before the text block, in the required order', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: 'the answer',
      thinkingText: 'let me work through this',
      thinkingSignature: 'sig-abc123',
    },
  ];
  const [msg] = toAnthropicMessages(messages);
  assert.deepEqual(msg.content, [
    { type: 'thinking', thinking: 'let me work through this', signature: 'sig-abc123' },
    { type: 'text', text: 'the answer' },
  ]);
});

test('a thinking turn with a tool call prepends thinking before the tool_use block', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: '',
      thinkingText: 'I should check the file',
      thinkingSignature: 'sig-xyz',
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
    },
  ];
  const [msg] = toAnthropicMessages(messages);
  assert.deepEqual(msg.content, [
    { type: 'thinking', thinking: 'I should check the file', signature: 'sig-xyz' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
  ]);
});

test('a redacted thinking turn replays the opaque data block instead of a readable thinking block', () => {
  const messages: Message[] = [
    { role: 'assistant', content: 'the answer', redactedThinking: 'opaque-encrypted-data' },
  ];
  const [msg] = toAnthropicMessages(messages);
  assert.deepEqual(msg.content, [
    { type: 'redacted_thinking', data: 'opaque-encrypted-data' },
    { type: 'text', text: 'the answer' },
  ]);
});

test('redactedThinking takes precedence over thinkingText/thinkingSignature if somehow both are set', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: 'x',
      thinkingText: 'should not appear',
      thinkingSignature: 'sig',
      redactedThinking: 'opaque',
    },
  ];
  const [msg] = toAnthropicMessages(messages);
  assert.deepEqual((msg.content as unknown[])[0], { type: 'redacted_thinking', data: 'opaque' });
});

test('thinkingSignature without thinkingText (malformed/partial) does not emit a broken thinking block', () => {
  const messages: Message[] = [{ role: 'assistant', content: 'x', thinkingSignature: 'sig-only' }];
  const [msg] = toAnthropicMessages(messages);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'x' }]);
});

test('user and tool messages are unaffected by the thinking-block changes', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'result', toolCallId: 'call_1' },
  ];
  const result = toAnthropicMessages(messages);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, 'hi');
  assert.equal(result[1].role, 'user'); // tool results are sent as a user-role tool_result block
});
