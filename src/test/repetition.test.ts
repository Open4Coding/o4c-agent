import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionDetector, REPEATS } from '../providers/repetition.js';
import { parseSseStream } from '../providers/local.js';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { FakeProvider } from './fakeProvider.js';

/** The loop recorded in docs/context window/fullContextWindow.txt: this block, fifteen times. */
const RECORDED = [
  'Also the seed content. Let me define the seeds:',
  '',
  'main.lisp: (as above)',
  '',
  'data.js: (as above)',
  '',
  'danger.js: (as above)',
  '',
  "Now the app.js code. Let's write it all carefully.",
  '',
  '',
].join('\n');

function chunks(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

test('the recorded "Also the seed content..." loop is caught within 3 repeats', () => {
  const d = new RepetitionDetector();
  const text = 'Thinking about the layout first.\n' + RECORDED.repeat(15);
  let consumed = 0;
  let found: string | undefined;
  for (const c of chunks(text)) {
    consumed += c.length;
    found = d.push(c);
    if (found) break;
  }
  assert.ok(found, 'detected');
  assert.match(found!, /^Also the seed content\. Let me define the seeds:\nmain\.lisp/);
  assert.ok(consumed <= 'Thinking about the layout first.\n'.length + RECORDED.length * REPEATS + 7, `consumed ${consumed}`); // + one chunk
});

test('ordinary text and code are not loops', () => {
  const code = Array.from({ length: 30 }, (_, i) => `  if (x === ${i}) {\n    return ${i};\n  }\n`).join('') + '}\n}\n}\n}\n';
  const prose = 'First I read the file.\nThen I fix the bug.\nThen I run the tests.\nThe tests pass.\n';
  const twice = 'This exact sentence is long enough to count as a block.\n'.repeat(2);
  for (const text of [code, prose, twice, 'ok\n'.repeat(50)]) {
    const d = new RepetitionDetector();
    assert.equal(chunks(text).map((c) => d.push(c)).find(Boolean), undefined, text.slice(0, 40));
  }
});

test('the stream is cut where the loop was seen, and says so', async () => {
  const body = chunks(RECORDED.repeat(15), 20)
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: c } }] })}\n\n`)
    .join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  const result = await parseSseStream(stream, undefined, undefined, undefined, undefined, new RepetitionDetector());
  assert.match(result.repetition!, /^Also the seed content/);
  assert.ok(result.content.length < RECORDED.length * 4, `kept ${result.content.length} chars`);
});

test('the loop nudges twice, then ends the turn', async () => {
  const looped = { content: '<think>Also the seed content.</think>', toolCalls: [], stopReason: 'end_turn' as const, repetition: 'Also the seed content. Let me define the seeds:' };
  const provider = new FakeProvider([looped, { content: 'Here is the answer.', toolCalls: [], stopReason: 'end_turn' }]);
  const events: AgentEvent[] = [];
  const loop = new AgentLoop(provider, [], 'system');
  assert.equal(await loop.run('go', { onEvent: (e) => events.push(e) }), 'Here is the answer.');
  assert.ok(events.some((e) => e.type === 'warning' && /started repeating itself/.test(e.text ?? '')));
  assert.match(JSON.stringify(provider.receivedRequests[1]!.messages), /You were repeating the same text/);

  const stuck = new AgentLoop(new FakeProvider([looped, looped, looped, { content: 'never', toolCalls: [], stopReason: 'end_turn' }]), [], 'system');
  const seen: AgentEvent[] = [];
  await stuck.run('go', { onEvent: (e) => seen.push(e) });
  assert.ok(seen.some((e) => e.type === 'warning' && /Stopped: the model kept repeating itself/.test(e.text ?? '')));
});
