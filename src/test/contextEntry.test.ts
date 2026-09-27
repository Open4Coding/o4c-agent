import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiResponseEntry,
  aiThinkEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  estimateTokens,
  liftLegacyMessages,
  splitThinkBlock,
  toWireMessages,
  userInputEntry,
} from '../agent/contextEntry.js';
import type { Message } from '../providers/types.js';

test('userInputEntry/aiResponseEntry produce the expected type/sub_type and a fresh id per call', () => {
  const a = userInputEntry('hi');
  const b = userInputEntry('hi');
  assert.equal(a.type, 'user');
  assert.equal(a.sub_type, 'input');
  assert.equal(a.content, 'hi');
  assert.equal(a.session_id, ''); // stamped in later by SessionStore.save(), not at creation
  assert.notEqual(a.id, b.id);

  const r = aiResponseEntry('answer');
  assert.equal(r.type, 'ai');
  assert.equal(r.sub_type, 'response');
});

test('aiToolCallEntry stores name/input as JSON content and carries tool_call_id/mutating', () => {
  const entry = aiToolCallEntry({ id: 't1', name: 'write_file', input: { path: 'x' } }, true);
  assert.equal(entry.type, 'ai');
  assert.equal(entry.sub_type, 'toolcall');
  assert.equal(entry.tool_call_id, 't1');
  assert.equal(entry.mutating, true);
  assert.deepEqual(JSON.parse(entry.content), { name: 'write_file', input: { path: 'x' } });
});

test('aiToolCallResponseEntry carries the raw output as content, plus tool_call_id/mutating', () => {
  const entry = aiToolCallResponseEntry('t1', 'wrote it', true);
  assert.equal(entry.type, 'ai');
  assert.equal(entry.sub_type, 'toolcallresponse');
  assert.equal(entry.content, 'wrote it');
  assert.equal(entry.tool_call_id, 't1');
});

test('aiThinkEntry produces an ai/think entry', () => {
  const entry = aiThinkEntry('reasoning here');
  assert.equal(entry.type, 'ai');
  assert.equal(entry.sub_type, 'think');
  assert.equal(entry.content, 'reasoning here');
});

test('splitThinkBlock: a properly closed <think> block is extracted, however many lines it spans', () => {
  const result = splitThinkBlock('<think>\nstep one\nstep two\n</think>\nthe answer is 4');
  assert.equal(result.think, 'step one\nstep two');
  assert.equal(result.response, 'the answer is 4');
});

test('splitThinkBlock: content before AND after the think block is preserved and joined', () => {
  const result = splitThinkBlock('before <think>reasoning</think> after');
  assert.equal(result.think, 'reasoning');
  assert.equal(result.response, 'before  after');
});

test('splitThinkBlock: no <think> tag at all just returns the content unchanged', () => {
  const result = splitThinkBlock('plain answer, no thinking');
  assert.equal(result.think, undefined);
  assert.equal(result.response, 'plain answer, no thinking');
});

test('splitThinkBlock: an unclosed <think> is cut at the next newline, not the rest of the message', () => {
  const result = splitThinkBlock('<think>brief reasoning\nthe actual answer\nmore answer text');
  assert.equal(result.think, 'brief reasoning');
  assert.equal(result.response, 'the actual answer\nmore answer text');
});

test('splitThinkBlock: an unclosed <think> with no newline at all becomes pure think, empty response', () => {
  const result = splitThinkBlock('<think>only reasoning, model never continued');
  assert.equal(result.think, 'only reasoning, model never continued');
  assert.equal(result.response, '');
});

test('splitThinkBlock: is case-insensitive on the tag itself', () => {
  const result = splitThinkBlock('<THINK>reasoning</THINK>answer');
  assert.equal(result.think, 'reasoning');
  assert.equal(result.response, 'answer');
});

test('toWireMessages: a think entry followed by a response entry join with a blank-line separator', () => {
  const messages = toWireMessages([
    userInputEntry('what is 2+2'),
    aiThinkEntry('2+2 is basic addition'),
    aiResponseEntry('4'),
  ]);
  assert.deepEqual(messages[1], { role: 'assistant', content: '2+2 is basic addition\n\n4', toolCalls: undefined });
});

test('toWireMessages: plain text turn, no tool calls', () => {
  const messages = toWireMessages([userInputEntry('hello'), aiResponseEntry('hi there')]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello', images: undefined },
    { role: 'assistant', content: 'hi there', toolCalls: undefined },
  ]);
});

test('toWireMessages: a response entry with an empty string content still produces an assistant message', () => {
  // Mirrors AgentLoop.run() always logging a response entry even when the provider's content is
  // '' (e.g. a tool-call-only turn) - toWireMessages must not silently drop it.
  const messages = toWireMessages([
    userInputEntry('do a thing'),
    aiResponseEntry(''),
    aiToolCallEntry({ id: 't1', name: 'tool_a', input: {} }, undefined),
    aiToolCallResponseEntry('t1', 'result A', undefined),
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'do a thing', images: undefined },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'tool_a', input: {} }] },
    { role: 'tool', content: 'result A', toolCallId: 't1' },
  ]);
});

test('toWireMessages: multiple tool calls from the same response collapse into one assistant message', () => {
  const messages = toWireMessages([
    userInputEntry('do both things'),
    aiResponseEntry(''),
    aiToolCallEntry({ id: 't1', name: 'tool_a', input: {} }, undefined),
    aiToolCallEntry({ id: 't2', name: 'tool_b', input: {} }, undefined),
    aiToolCallResponseEntry('t1', 'result A', undefined),
    aiToolCallResponseEntry('t2', 'result B', undefined),
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'do both things', images: undefined },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 't1', name: 'tool_a', input: {} },
        { id: 't2', name: 'tool_b', input: {} },
      ],
    },
    { role: 'tool', content: 'result A', toolCallId: 't1' },
    { role: 'tool', content: 'result B', toolCallId: 't2' },
  ]);
});

test('toWireMessages: two separate provider iterations within one turn stay two separate assistant messages', () => {
  const messages = toWireMessages([
    userInputEntry('multi-step task'),
    aiResponseEntry('let me check'),
    aiToolCallEntry({ id: 't1', name: 'read_file', input: { path: 'x' } }, undefined),
    aiToolCallResponseEntry('t1', 'file contents', undefined),
    aiResponseEntry('the file says: file contents'),
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'multi-step task', images: undefined },
    {
      role: 'assistant',
      content: 'let me check',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'x' } }],
    },
    { role: 'tool', content: 'file contents', toolCallId: 't1' },
    { role: 'assistant', content: 'the file says: file contents', toolCalls: undefined },
  ]);
});

test('toWireMessages: system-type entries are never sent to the model', () => {
  const messages = toWireMessages([
    userInputEntry('hello'),
    { ...aiResponseEntry(''), type: 'system', sub_type: 'mode-change', content: 'Mode set to Plan.' },
    aiResponseEntry('hi'),
  ]);
  assert.deepEqual(
    messages.map((m) => m.content),
    ['hello', 'hi'],
  );
});

test('toWireMessages: user images survive the projection', () => {
  const messages = toWireMessages([userInputEntry('look at this', ['/tmp/a.png'])]);
  assert.deepEqual(messages[0], { role: 'user', content: 'look at this', images: ['/tmp/a.png'] });
});

test('liftLegacyMessages then toWireMessages round-trips a pre-refactor session faithfully', () => {
  const legacy: Message[] = [
    { role: 'user', content: 'what does foo.txt say?' },
    {
      role: 'assistant',
      content: 'let me check',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'foo.txt' } }],
    },
    { role: 'tool', content: 'file contents here', toolCallId: 't1' },
    { role: 'assistant', content: 'the file says: file contents here' },
  ];

  const roundTripped = toWireMessages(liftLegacyMessages(legacy));
  // JSON round-trip drops explicit `undefined` values on both sides (e.g. toWireMessages always
  // sets `toolCalls: undefined` when there are none, vs. the legacy fixture simply omitting the
  // key) - the two are equivalent wire messages, this test cares about content, not key presence.
  assert.deepEqual(JSON.parse(JSON.stringify(roundTripped)), JSON.parse(JSON.stringify(legacy)));
});

test('toWireMessages: an entry with agent_visible=false is dropped, even though it is not type=system', () => {
  const kept = userInputEntry('kept');
  const dropped = { ...aiResponseEntry('old, replaced by a summary'), agent_visible: false };
  const messages = toWireMessages([kept, dropped, aiResponseEntry('summary of everything above')]);
  assert.deepEqual(
    messages.map((m) => m.content),
    ['kept', 'summary of everything above'],
  );
});

test('toWireMessages: agent_visible left undefined (the common case - no compaction has run) sends the entry as normal', () => {
  const messages = toWireMessages([userInputEntry('hi'), aiResponseEntry('hello')]);
  assert.deepEqual(
    messages.map((m) => m.content),
    ['hi', 'hello'],
  );
});

test('estimateTokens: roughly chars/4, rounded up', () => {
  assert.equal(estimateTokens(aiResponseEntry('')), 0);
  assert.equal(estimateTokens(aiResponseEntry('abcd')), 1);
  assert.equal(estimateTokens(aiResponseEntry('abcde')), 2); // rounds up, not down
});

test('liftLegacyMessages: a tool-call-only assistant message (empty content) produces no spurious response entry', () => {
  const legacy: Message[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'tool_a', input: {} }] },
    { role: 'tool', content: 'result', toolCallId: 't1' },
  ];
  const entries = liftLegacyMessages(legacy);
  // No 'response' entry for the empty-content assistant message - only user/toolcall/toolcallresponse.
  assert.deepEqual(
    entries.map((e) => e.sub_type),
    ['input', 'toolcall', 'toolcallresponse'],
  );
});
