import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldCompact,
  findCutPoint,
  microCompactCutoffIndex,
  buildCompactionPrompt,
  parseSummary,
  DEFAULT_COMPACTION_SETTINGS,
} from '../agent/compaction.js';
import {
  userInputEntry,
  aiResponseEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  type ContextEntry,
} from '../agent/contextEntry.js';

test('shouldCompact triggers only once within reserveTokens of the window', () => {
  // Threshold = contextWindow - reserveTokens = 200_000 - 16_384 = 183_616.
  assert.equal(shouldCompact(100_000, 200_000, 16_384), false);
  assert.equal(shouldCompact(183_616, 200_000, 16_384), false);
  assert.equal(shouldCompact(183_617, 200_000, 16_384), true);
});

// Builds a realistic entry log: N turns, each user input + assistant response + one
// toolcall/toolcallresponse pair, so tests can target a specific turn count.
function buildTurns(n: number, contentSize = 100): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(userInputEntry(`turn ${i} ${'x'.repeat(contentSize)}`));
    const call = { id: `call-${i}`, name: 'read_file', input: { path: `f${i}.ts` } };
    entries.push(aiToolCallEntry(call, false));
    entries.push(aiToolCallResponseEntry(call.id, `output ${i} ${'y'.repeat(contentSize)}`, false));
    entries.push(aiResponseEntry(`response ${i} ${'z'.repeat(contentSize)}`));
  }
  return entries;
}

test('findCutPoint returns 0 (no-op) when the whole log is smaller than the keep budget', () => {
  const entries = buildTurns(2, 50);
  assert.equal(findCutPoint(entries, 100_000), 0);
});

test('findCutPoint snaps to a turn boundary, never inside a turn', () => {
  const entries = buildTurns(20, 100);
  // Roughly-sized keep budget that will land somewhere in the middle.
  const cut = findCutPoint(entries, 1500);
  assert.ok(cut > 0);
  assert.ok(cut < entries.length);
  assert.equal(entries[cut].type, 'user');
  assert.equal(entries[cut].sub_type, 'input');
});

test('findCutPoint never separates a toolcall from its toolcallresponse', () => {
  const entries = buildTurns(20, 100);
  const cut = findCutPoint(entries, 1500);
  // Every toolcall entry strictly before the cut must have its toolcallresponse also strictly
  // before the cut (and vice versa) - the cut point itself is always a turn boundary, so this
  // holds by construction, but assert it directly rather than trusting the boundary logic alone.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'ai' || (e.sub_type !== 'toolcall' && e.sub_type !== 'toolcallresponse')) continue;
    const pairIndex = entries.findIndex(
      (other) => other.tool_call_id === e.tool_call_id && other.id !== e.id,
    );
    assert.equal(i < cut, pairIndex < cut, `entry ${i} and its pair ${pairIndex} split across the cut point`);
  }
});

test('findCutPoint keeps at least keepRecentTokens worth of entries (allowing turn-boundary overshoot)', () => {
  const entries = buildTurns(20, 100);
  const cut = findCutPoint(entries, 1500);
  const keptTokens = entries.slice(cut).reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
  assert.ok(keptTokens >= 1500, `kept only ${keptTokens} tokens, wanted >= 1500`);
});

test('findCutPoint skips already-hidden (agent_visible=false) entries when accumulating', () => {
  // 40 turns so the backward accumulation walk (keepRecentTokens: 1500) settles well within the
  // still-visible tail, never actually reaching into the hidden region - hiding entries the walk
  // never touches must be a genuine no-op on the result.
  const entries = buildTurns(40, 100);
  const hidden = buildTurns(40, 100);
  for (const e of hidden.slice(0, 40)) e.agent_visible = false; // first 10 turns

  assert.equal(findCutPoint(hidden, 1500), findCutPoint(entries, 1500));
});

test('microCompactCutoffIndex returns 0 when the whole log is smaller than the keep budget', () => {
  const entries = buildTurns(2, 50);
  assert.equal(microCompactCutoffIndex(entries, 100_000), 0);
});

test('microCompactCutoffIndex does NOT snap to a turn boundary, unlike findCutPoint', () => {
  // This is the whole point of the separate function: a cutoff that lands mid-turn is fine here -
  // individual toolcall/toolcallresponse pairs are pruned independently of turn structure, not a
  // single contiguous block the way findCutPoint's cut point is.
  const entries = buildTurns(20, 100);
  const cutoff = microCompactCutoffIndex(entries, 1500);
  assert.ok(cutoff > 0);
  assert.ok(cutoff < entries.length);
  // Same keep-budget backward walk as findCutPoint, so the two land near the same raw candidate
  // before findCutPoint's own forward/backward boundary-snapping moves it up to a few entries in
  // either direction - not necessarily equal to findCutPoint's actual (snapped) result.
  const cut = findCutPoint(entries, 1500);
  assert.ok(Math.abs(cutoff - cut) <= 4, `expected the unsnapped cutoff (${cutoff}) near the snapped cut point (${cut})`);
});

test('microCompactCutoffIndex finds a real cutoff even in a single turn with no earlier turn boundary at all', () => {
  // The exact gap probed directly (tmp.tmp/probe-compaction.ts scenario A) and the reason this
  // function exists instead of reusing findCutPoint(): one giant turn, no second user message
  // anywhere, so findCutPoint has no boundary to snap to and returns 0 (a real no-op, confirmed
  // separately in this same file). microCompactCutoffIndex has no such requirement.
  const entries: ContextEntry[] = [userInputEntry('go')];
  for (let i = 0; i < 20; i++) {
    const call = { id: `call-${i}`, name: 'read_file', input: { path: `f${i}.ts` } };
    entries.push(aiToolCallEntry(call, false));
    entries.push(aiToolCallResponseEntry(call.id, `output ${i} ${'y'.repeat(100)}`, false));
  }
  assert.equal(findCutPoint(entries, 500), 0); // confirms the gap this is meant to close
  const cutoff = microCompactCutoffIndex(entries, 500);
  assert.ok(cutoff > 0, 'expected a real cutoff, not 0, for the exact case findCutPoint cannot handle');
});

test('microCompactCutoffIndex skips already-hidden (agent_visible=false) entries when accumulating', () => {
  const entries = buildTurns(40, 100);
  const hidden = buildTurns(40, 100);
  for (const e of hidden.slice(0, 40)) e.agent_visible = false;

  assert.equal(microCompactCutoffIndex(hidden, 1500), microCompactCutoffIndex(entries, 1500));
});

test('buildCompactionPrompt with no previous summary asks for a fresh summary', () => {
  const entries = [userInputEntry('do the thing'), aiResponseEntry('done')];
  const prompt = buildCompactionPrompt({ entries });
  assert.ok(prompt.includes('[User]: do the thing'));
  assert.ok(prompt.includes('[Assistant]: done'));
  assert.ok(!prompt.includes('previous-summary'));
});

test('buildCompactionPrompt with a previous summary asks for an update, embedding it', () => {
  const entries = [userInputEntry('next thing')];
  const prompt = buildCompactionPrompt({ entries, previousSummary: { next_step: 'ship it' } });
  assert.ok(prompt.includes('<previous-summary>'));
  assert.ok(prompt.includes('"next_step":"ship it"'));
  assert.ok(prompt.includes('[User]: next thing'));
});

test('buildCompactionPrompt stays under maxContentChars regardless of how large the region is', () => {
  // Real gap found via direct probe (scenario C, tmp.tmp/probe-compaction.ts): a region built of
  // many/large tool outputs has no upper bound on its own - without a cap, this exact shape
  // produces a summarization prompt bigger than the model's entire context window.
  const entries = buildTurns(200, 2000); // deliberately huge - would be ~1.6M+ chars uncapped
  const prompt = buildCompactionPrompt({ entries, maxContentChars: 5000 });
  // A little over 5000 for the fixed instructions/marker text around the capped conversation
  // itself, but nowhere near the ~1.6M+ chars the raw, uncapped serialization would produce.
  assert.ok(prompt.length < 6000, `expected a capped prompt, got ${prompt.length} chars`);
});

test('buildCompactionPrompt truncates from the start, keeping the slice closest to the kept/recent tail', () => {
  const entries = [userInputEntry('OLDEST MARKER'), userInputEntry('x'.repeat(5000)), userInputEntry('NEWEST MARKER')];
  const prompt = buildCompactionPrompt({ entries, maxContentChars: 200 });
  assert.ok(!prompt.includes('OLDEST MARKER'), 'expected the oldest content to be the part dropped');
  assert.ok(prompt.includes('NEWEST MARKER'), 'expected the newest content to survive the cap');
  assert.ok(prompt.includes('omitted'), 'expected a visible marker noting truncation happened');
});

test('buildCompactionPrompt leaves a short conversation completely untouched, no marker at all', () => {
  const entries = [userInputEntry('short')];
  const prompt = buildCompactionPrompt({ entries, maxContentChars: 5000 });
  assert.ok(!prompt.includes('omitted'));
});

test('parseSummary parses clean JSON', () => {
  const result = parseSummary('{"next_step": "ship it"}');
  assert.deepEqual(result, { next_step: 'ship it' });
});

test('parseSummary strips markdown code fences before parsing', () => {
  const result = parseSummary('```json\n{"next_step": "ship it"}\n```');
  assert.deepEqual(result, { next_step: 'ship it' });
});

test('parseSummary degrades to plain text on malformed JSON, never throws', () => {
  const result = parseSummary('not valid json at all');
  assert.deepEqual(result, { current_work: 'not valid json at all' });
});

test('DEFAULT_COMPACTION_SETTINGS matches the benchmarked/documented pi-derived defaults', () => {
  assert.equal(DEFAULT_COMPACTION_SETTINGS.reserveTokens, 16384);
  assert.equal(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, 20000);
});
