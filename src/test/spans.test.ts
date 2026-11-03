import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../agent/loop.js';
import { TurnTracer, type PendingSpan } from '../agent/tracer.js';
import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { formatTrace, recentTurns, timeShares, turnSpans, type SpanRow } from '../session/spans.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';

/** Plan 0006 K3: span tracing of a turn, the spans table, /trace's timeline. */

function scriptedTurn() {
  const provider = new FakeProvider([
    {
      content: 'let me look',
      toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.txt' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 1200, outputTokens: 40, cachedTokens: 1000, tokensPerSecond: 40 },
    },
    { content: 'done', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1300, outputTokens: 10 } },
  ]);
  return new AgentLoop(provider, [makeFakeTool('read_file', 'twelve chars')], 'system');
}

test('a turn traces as one turn span with its model and tool calls under it, in call order', async () => {
  const loop = scriptedTurn();
  const turns: PendingSpan[][] = [];
  loop.setTracer(new TurnTracer((spans) => turns.push([...spans])));
  await loop.run('read a.txt\nand tell me');

  assert.equal(turns.length, 1, 'one flush per turn');
  const spans = turns[0]!;
  const turn = spans.find((s) => s.kind === 'turn')!;
  assert.equal(turn.name, 'read a.txt', 'named after the first line of the message');
  assert.deepEqual(
    spans.filter((s) => s !== turn).map((s) => `${s.kind}:${s.kind === 'tool' ? s.name : ''}`),
    ['model:', 'tool:read_file', 'model:'],
  );
  for (const s of spans) if (s !== turn) assert.equal(s.parent, turn.key, `${s.kind} hangs off the turn`);
  const [first] = spans.filter((s) => s.kind === 'model');
  assert.deepEqual(
    { p: first!.attrs.prompt_tokens, c: first!.attrs.cached_tokens, g: first!.attrs.gen_tokens, r: first!.attrs.tok_s },
    { p: 1200, c: 1000, g: 40, r: 40 },
  );
  assert.equal(spans.find((s) => s.kind === 'tool')!.attrs.bytes, 'twelve chars'.length);
  for (const s of spans) assert.ok(s.durMs >= 0, 'every span is closed');
});

test('no tracer, no spans - and a failed turn still writes its turn span, marked with the error', async () => {
  const quiet = scriptedTurn();
  assert.equal(await quiet.run('hi'), 'done');

  const failing = new AgentLoop(new FakeProvider([]), [], 'system');
  const turns: PendingSpan[][] = [];
  failing.setTracer(new TurnTracer((spans) => turns.push([...spans])));
  await assert.rejects(failing.run('hi'));
  const turn = turns[0]?.find((s) => s.kind === 'turn');
  assert.ok(turn?.attrs.error, 'the turn span says it failed');
  assert.ok(turns[0]!.find((s) => s.kind === 'model')?.attrs.error, 'and so does the model call');
});

test('the spans table round-trips a turn, /trace shows it as a timeline, and old turns are pruned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-spans-'));
  const store = new InfiniteContextStore(join(dir, 'history.db'));
  try {
    const loop = scriptedTurn();
    loop.setTracer(new TurnTracer((spans) => store.spans().writeTurn('s1', spans)));
    await loop.run('read a.txt');

    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    const [turn] = recentTurns(db);
    assert.ok(turn);
    const rows = turnSpans(db, turn.id);
    assert.deepEqual(rows.map((r) => r.kind), ['turn', 'model', 'tool', 'model']);
    for (const r of rows.slice(1)) assert.equal(r.parent_id, turn.id);

    const text = formatTrace(rows).join('\n');
    assert.match(text, /^Turn "read a\.txt"/);
    assert.match(text, /tool read_file/);
    assert.match(text, /prompt 1,200 \(cached 1,000\) · gen 40 @ 40\.0 tok\/s/);
    assert.match(text, /Where the time went: .*tools \d+%/);

    // Pruning by age: everything older than two weeks goes.
    assert.equal(store.spans().prune(Date.now() + 15 * 86_400_000), rows.length);
    assert.equal(recentTurns(db).length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('where the time went: a model call is split into prefill and generation by its decode rate', () => {
  const row = (id: number, kind: string, dur: number, attrs: object = {}): SpanRow => ({
    id, parent_id: id === 1 ? null : 1, session_id: 's', turn_id: 1, kind, name: kind, started_at: 0, dur_ms: dur, attrs: JSON.stringify(attrs),
  });
  // 10 s turn: a 6 s model call that generated 100 tokens at 25 tok/s (4 s generating, 2 s prefill),
  // 3 s of tools, 1 s of nothing traced.
  const t = timeShares([row(1, 'turn', 10_000), row(2, 'model', 6000, { gen_tokens: 100, tok_s: 25 }), row(3, 'tool', 3000)]);
  assert.deepEqual(
    { prefill: t.prefill, generation: t.generation, tools: t.tools, other: t.other },
    { prefill: 2000, generation: 4000, tools: 3000, other: 1000 },
  );
});

test('tracing is cheap: ten thousand spans cost well under a millisecond each', () => {
  // The acceptance bar is under 1% of turn time. A turn with a hundred calls takes seconds; at this
  // rate its spans cost a few milliseconds at most.
  let written = 0;
  const tracer = new TurnTracer((spans) => (written = spans.length));
  const started = performance.now();
  const turn = tracer.start('turn', 't');
  for (let i = 0; i < 10_000; i++) tracer.start('tool', 'x', turn).end({ bytes: i });
  turn.end();
  tracer.flush();
  const perSpanMs = (performance.now() - started) / 10_000;
  assert.equal(written, 10_001);
  assert.ok(perSpanMs < 0.05, `${perSpanMs} ms per span`);
});
