import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toOpenAIMessages } from '../providers/local.js';
import type { Message } from '../providers/types.js';

/** Plan 0006 A7: what an assistant message's reasoning becomes on the way to llama-server. */

const history: Message[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer', reasoning: 'old thoughts' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: '', reasoning: 'current thoughts', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }] },
  { role: 'tool', content: 'file text', toolCallId: 'c1' },
];

test('all (default): reasoning_content on every assistant message, never folded into content', async () => {
  const out = (await toOpenAIMessages('sys', history)).filter((m) => m.role === 'assistant') as unknown as Array<Record<string, unknown>>;
  assert.equal(out[0]!.reasoning_content, 'old thoughts');
  assert.equal(out[0]!.content, 'first answer');
  assert.equal(out[1]!.reasoning_content, 'current thoughts');
});

test('current-turn: reasoning_content only after the last user message; old reasoning not sent', async () => {
  const out = await toOpenAIMessages('sys', history, 'current-turn');
  const assistants = out.filter((m) => m.role === 'assistant') as unknown as Array<Record<string, unknown>>;
  assert.equal(assistants[0]!.reasoning_content, undefined);
  assert.equal(assistants[0]!.content, 'first answer', 'never folded into content');
  assert.equal(assistants[1]!.reasoning_content, 'current thoughts');
  assert.equal(assistants[1]!.content, null);
  assert.ok(!JSON.stringify(out).includes('old thoughts'));
});

test('none drops reasoning; all-as-text restores the old behaviour', async () => {
  const none = await toOpenAIMessages('sys', history, 'none');
  assert.ok(!JSON.stringify(none).includes('thoughts'));
  const asText = (await toOpenAIMessages('sys', history, 'all-as-text')).filter((m) => m.role === 'assistant');
  assert.equal(asText[0]!.content, 'old thoughts\n\nfirst answer');
  assert.equal(asText[1]!.content, 'current thoughts');
  assert.ok(!('reasoning_content' in asText[1]!));
});
