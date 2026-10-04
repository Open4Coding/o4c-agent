import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseStream } from '../providers/local.js';

/** Builds a real ReadableStream<Uint8Array> from a list of raw string chunks - each array
 * element is delivered as its own `reader.read()` result, so tests can control exactly where a
 * network boundary falls (including mid-JSON-object, to exercise the buffering logic). */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i++;
    },
  });
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test('reasoning_content deltas (llama-server\'s reasoning_format: "deepseek" extension) are wrapped into <think>...</think> and prefixed onto content', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { reasoning_content: 'The user ' } }] }),
    sse({ choices: [{ delta: { reasoning_content: 'wants a greeting' } }] }),
    sse({ choices: [{ delta: { content: 'Hello!' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, '<think>The user wants a greeting</think>Hello!');
});

test('reasoning_content deltas stream through onToken as they arrive, same as content', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
    sse({ choices: [{ delta: { content: 'answer' } }] }),
  ]);

  const seen: string[] = [];
  await parseSseStream(stream, (delta) => seen.push(delta));

  assert.deepEqual(seen, ['thinking...', 'answer']);
});

test('onToken receives the correct kind per chunk - "think" for reasoning_content, "text" for content', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
    sse({ choices: [{ delta: { content: 'answer' } }] }),
  ]);

  const seen: Array<{ delta: string; kind: 'think' | 'text' }> = [];
  await parseSseStream(stream, (delta, kind) => seen.push({ delta, kind }));

  assert.deepEqual(seen, [
    { delta: 'thinking...', kind: 'think' },
    { delta: 'answer', kind: 'text' },
  ]);
});

test('no reasoning_content at all leaves content unwrapped, unchanged from before', async () => {
  const stream = sseStream([sse({ choices: [{ delta: { content: 'plain answer' } }] })]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, 'plain answer');
});

test('reasoning_content followed directly by a tool call (no regular content at all) - the exact real case that surfaced this bug', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { reasoning_content: 'let me check the directory' } }] }),
    sse({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_shell', arguments: '{"command":"dir"}' } }] } },
      ],
    }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, '<think>let me check the directory</think>');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'run_shell', input: { command: 'dir' } }]);
  assert.equal(result.finishReason, 'tool_calls');
});

test('accumulates plain text content across multiple chunks', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { content: 'Hello' } }] }),
    sse({ choices: [{ delta: { content: ', world' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, 'Hello, world');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.toolCalls, []);
});

test('calls onToken with each content delta as it arrives, in order', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { content: 'a' } }] }),
    sse({ choices: [{ delta: { content: 'b' } }] }),
    sse({ choices: [{ delta: { content: 'c' } }] }),
  ]);

  const seen: string[] = [];
  await parseSseStream(stream, (delta) => seen.push(delta));

  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('accumulates a single tool call whose arguments arrive across several chunks', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);

  const result = await parseSseStream(stream);

  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
});

test('accumulates multiple parallel tool calls, keyed by index, in index order', async () => {
  const stream = sseStream([
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, id: 'call_b', function: { name: 'tool_b', arguments: '{}' } },
              { index: 0, id: 'call_a', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
        },
      ],
    }),
  ]);

  const result = await parseSseStream(stream);

  assert.deepEqual(result.toolCalls, [
    { id: 'call_a', name: 'tool_a', input: {} },
    { id: 'call_b', name: 'tool_b', input: {} },
  ]);
});

test('extracts usage from the final chunk (stream_options.include_usage)', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { content: 'hi' } }] }),
    sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }),
  ]);

  const result = await parseSseStream(stream);

  assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 5 });
});

test('usage is undefined when the server never sends a usage chunk', async () => {
  const stream = sseStream([sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })]);

  const result = await parseSseStream(stream);

  assert.equal(result.usage, undefined);
});

test('a malformed chunk is skipped, not fatal to the rest of the stream', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { content: 'before ' } }] }),
    'data: {not valid json\n\n',
    sse({ choices: [{ delta: { content: 'after' } }] }),
  ]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, 'before after');
});

test('handles a JSON object split across two raw network chunks (buffering)', async () => {
  const wholeLine = sse({ choices: [{ delta: { content: 'split across chunks' } }] });
  const splitPoint = Math.floor(wholeLine.length / 2);
  const stream = sseStream([wholeLine.slice(0, splitPoint), wholeLine.slice(splitPoint)]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, 'split across chunks');
});

test('defaults finishReason to "stop" if the stream never sends one', async () => {
  const stream = sseStream([sse({ choices: [{ delta: { content: 'no finish reason field' } }] })]);

  const result = await parseSseStream(stream);

  assert.equal(result.finishReason, 'stop');
});

test('non-"data:" lines (blank keep-alives, comments) are ignored', async () => {
  const stream = sseStream([': keep-alive\n\n', sse({ choices: [{ delta: { content: 'real' } }] })]);

  const result = await parseSseStream(stream);

  assert.equal(result.content, 'real');
});

test('a tool call whose arguments were cut off mid-JSON by max_tokens is dropped, not thrown', async () => {
  // Real bug found via direct reproduction (2026-10-03, a --parallel 1 run at only 16% context
  // use - so not a context-pressure problem at all): a write_file with a large `content` hit the
  // max_tokens cap mid-arguments, and the unguarded JSON.parse here threw straight out to the UI
  // as "Unexpected error: Unterminated string in JSON at position 27918", killing the whole turn.
  // A truncated tool call is a normal consequence of hitting the output cap - drop it and let
  // loop.ts's existing max_tokens auto-continue retry the round.
  const stream = sseStream([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.js","content":"const x = \\"unterminated' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]);

  const result = await parseSseStream(stream);

  assert.deepEqual(result.toolCalls, [], 'the unparseable tool call should be dropped');
  assert.equal(result.finishReason, 'length', 'the max_tokens stop reason still surfaces so the caller can retry');
});

test('a well-formed tool call alongside a truncated one still comes through', async () => {
  const stream = sseStream([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'good', function: { name: 'read_file', arguments: '{"path":"x.js"}' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'bad', function: { name: 'write_file', arguments: '{"path":"y.js","content":"oops' } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]);

  const result = await parseSseStream(stream);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'good');
  assert.deepEqual(result.toolCalls[0].input, { path: 'x.js' });
});
