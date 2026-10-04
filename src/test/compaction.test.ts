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
  estimateTokens,
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
  // A safe cut is either a new user message, or right after a completed tool result (2026-10-04:
  // single-turn tool rounds are now valid boundaries too). Never mid-round.
  const atUser = entries[cut].type === 'user' && entries[cut].sub_type === 'input';
  const afterToolResult = entries[cut - 1].sub_type === 'toolcallresponse';
  assert.ok(atUser || afterToolResult, 'cut must be a user message or immediately after a tool result');
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

test('findCutPoint never undershoots keepRecentTokens, even when a huge turn sits right where the raw walk lands', () => {
  // Real gap found via direct probe (tmp.tmp/probe-compaction.ts scenario D): the raw backward
  // walk lands inside a huge turn, with only a small tail of turns after it - snapping forward
  // (the original, buggy behavior) moves the cut into that small tail, undershooting the keep
  // budget. Snapping backward first (the fix) moves the cut to before the giant turn instead,
  // overshooting the budget rather than undershooting it - never violating the documented floor.
  // estimateTokens() = ceil(len/4), so len = tokens*4 lands on ~tokens exactly - needed here (unlike
  // buildTurns' own approximate char-repeat sizing) to precisely land the raw candidate inside the
  // giant turn's own huge entry, which is the specific case this regression is about.
  const exact = (tokens: number): string => 'x'.repeat(tokens * 4);
  function smallTurns(n: number): ContextEntry[] {
    const out: ContextEntry[] = [];
    for (let i = 0; i < n; i++) {
      const call = { id: `c${i}`, name: 'read_file', input: { path: `f${i}` } };
      out.push(userInputEntry(exact(25)));
      out.push(aiToolCallEntry(call, false));
      out.push(aiToolCallResponseEntry(call.id, exact(25), false));
      out.push(aiResponseEntry(exact(25)));
    }
    return out;
  }
  const call = { id: 'big', name: 'run_shell', input: { command: 'x' } };
  const entries: ContextEntry[] = [
    ...smallTurns(6), // ~600 tokens
    userInputEntry(exact(25)),
    aiToolCallEntry(call, false),
    aiToolCallResponseEntry(call.id, exact(3000), false), // the huge entry the raw walk lands inside
    aiResponseEntry(exact(25)),
    ...smallTurns(6), // ~600 tokens - too small on its own to reach keepRecentTokens
  ];
  const cut = findCutPoint(entries, 2000);
  const kept = entries.slice(cut).reduce((sum, e) => sum + (e.agent_visible !== false ? estimateTokens(e) : 0), 0);
  assert.ok(kept >= 2000, `kept only ${kept} tokens, wanted >= 2000 (keepRecentTokens)`);
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
  // Previously findCutPoint returned 0 here - the exact single-turn gap. Now a completed tool round
  // is a valid tier-3 cut, so it finds one too (2026-10-04).
  const tier3Cut = findCutPoint(entries, 500);
  assert.ok(tier3Cut > 0, 'tier-3 should now find a cut inside a single tool-heavy turn');
  assert.equal(entries[tier3Cut - 1].sub_type, 'toolcallresponse');
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

test('findCutPoint: a single turn with no user message still cuts at a completed tool round', () => {
  // Real bug (2026-10-04): a long single turn has one user message at the start and none after,
  // so the turn-boundary rule alone returned 0 forever and tier-3 summarization never fired while
  // reasoning/response text grew to the hard-stop. A completed tool round is a valid cut point.
  const entries: ContextEntry[] = [userInputEntry('build it')];
  for (let i = 0; i < 6; i++) {
    entries.push(aiResponseEntry('x'.repeat(400)));
    entries.push(aiToolCallEntry({ id: `t${i}`, name: 'write_file', input: {} }));
    entries.push(aiToolCallResponseEntry(`t${i}`, 'ok'));
  }
  const cut = findCutPoint(entries, 200);
  assert.ok(cut > 0, 'expected a cut point inside the single turn, not 0');
  assert.equal(entries[cut - 1].sub_type, 'toolcallresponse', 'the cut must land right after a completed tool result');
});

test('findCutPoint never splits a tool call from its result', () => {
  const entries: ContextEntry[] = [userInputEntry('go')];
  for (let i = 0; i < 4; i++) {
    entries.push(aiToolCallEntry({ id: `s${i}`, name: 'read_file', input: {} }));
    entries.push(aiToolCallResponseEntry(`s${i}`, 'y'.repeat(200)));
  }
  const cut = findCutPoint(entries, 100);
  if (cut > 0) {
    assert.notEqual(entries[cut].sub_type, 'toolcallresponse', 'the first kept entry must not be an orphaned result');
    assert.notEqual(entries[cut - 1].sub_type, 'toolcall', 'the last summarized entry must not be an orphaned call');
  }
});

test('buildCompactionPrompt survives a tool-call entry whose content was released to a placeholder (2026-10-04)', () => {
  // Real failure: compaction serialized every entry in the region it folds away, including ones an
  // earlier pass already released, and JSON.parse on the placeholder threw - killing the turn.
  const released = aiToolCallEntry({ id: 'r1', name: 'write_file', input: {} });
  released.content = '[toolcall content released from memory after compaction]';
  const prompt = buildCompactionPrompt({ entries: [userInputEntry('go'), released], previousSummary: undefined, maxContentChars: 10_000 });
  assert.match(prompt, /released from memory/);
});
