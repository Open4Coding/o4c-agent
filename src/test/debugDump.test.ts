import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDebugDump, lastRequestFromLog, lastRequestFromLogs } from '../session/debugDump.js';

const tool = { name: 'read_file', description: 'read', inputSchema: { type: 'object' as const, properties: {} } };

function log(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

test('lastRequestFromLog replays the full call and the deltas after it', () => {
  const jsonl = log(
    { type: 'provider_call', request: { systemPrompt: 'SYS1', messages: [{ role: 'user', content: 'hi' }], tools: [tool] }, response: { text: 'r1' } },
    { type: 'provider_call_delta', messages: [{ role: 'assistant', content: 'r1' }, { role: 'user', content: 'next' }], response: { text: 'r2' } },
    { type: 'provider_call_delta', systemPrompt: 'SYS2', messages: [], response: { text: 'r3' } },
  );
  const r = lastRequestFromLog(jsonl)!;
  assert.equal(r.systemPrompt, 'SYS2');
  assert.deepEqual(r.messages.map((m) => m.content), ['hi', 'r1', 'next']);
  assert.equal(r.tools[0]!.name, 'read_file');
  assert.deepEqual(r.response, { text: 'r3' });
  assert.equal(lastRequestFromLog(log({ type: 'provider_call_delta', messages: [] })), undefined, 'a delta with no full call before it is not a request');
});

test('a later full call (after compaction) starts the replay over', () => {
  const jsonl = log(
    { type: 'provider_call', request: { systemPrompt: 'S', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], tools: [] } },
    { type: 'provider_call', request: { systemPrompt: 'S', messages: [{ role: 'user', content: 'summary' }], tools: [] } },
  );
  assert.deepEqual(lastRequestFromLog(jsonl)!.messages.map((m) => m.content), ['summary']);
});

test('lastRequestFromLogs takes the newest FULLCONTEXT log that has a request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-debug-'));
  try {
    assert.equal(lastRequestFromLogs(dir), undefined);
    writeFileSync(join(dir, '2026-11-01T00-00-00-000Z.FULLCONTEXT.jsonl'), log({ type: 'provider_call', request: { systemPrompt: 'old', messages: [], tools: [] } }));
    writeFileSync(join(dir, '2026-11-02T00-00-00-000Z.FULLCONTEXT.jsonl'), log({ type: 'other' }));
    writeFileSync(join(dir, '2026-11-03T00-00-00-000Z.jsonl'), log({ type: 'provider_call', request: { systemPrompt: 'not fullcontext', messages: [], tools: [] } }));
    const found = lastRequestFromLogs(dir)!;
    assert.equal(found.request.systemPrompt, 'old');
    assert.ok(found.file.endsWith('2026-11-01T00-00-00-000Z.FULLCONTEXT.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatDebugDump puts the why first, then the exact request and the raw response', () => {
  const text = formatDebugDump(
    {
      request: {
        systemPrompt: 'You are o4c.',
        messages: [
          { role: 'user', content: 'fix it\n\n[note] plan step 2' },
          { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'a' } }] } as never,
        ],
        tools: [tool],
        response: { text: 'done' },
      },
      source: 'this process',
      breakdown: ['system 10', 'messages 20'],
      window: 'full history',
      historyEntries: 7,
      cacheBreak: 'tools changed',
      rules: ['allow run_shell(npm test)'],
      model: 'qwen',
      thinkLevel: 'med',
    },
    new Date('2026-11-02T12:00:00Z'),
  );
  const why = text.indexOf('## Why');
  assert.ok(why > 0 && why < text.indexOf('## System prompt') && text.indexOf('## System prompt') < text.indexOf('## Response'));
  assert.match(text, /# o4c \/debug - 2026-11-02T12:00:00\.000Z/);
  assert.match(text, /2 messages sent, 7 entries/);
  assert.match(text, /Last cache break: tools changed/);
  assert.match(text, /Tools offered: 1 \(read_file\)/);
  assert.match(text, /fix it\n\n\[note\] plan step 2/);
  assert.match(text, /### \[1\] assistant\n\n```\ntool calls:/);
  assert.match(text, /"text": "done"/);
});
