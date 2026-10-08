import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../agent/loop.js';
import {
  userInputEntry,
  aiResponseEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  type ContextEntry,
} from '../agent/contextEntry.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';

// content.length 400 -> estimateTokens() (chars/4) = 100 tokens per entry, 200 per turn.
function padded(label: string): string {
  return `${label} ${'x'.repeat(396)}`.slice(0, 400);
}

/** `n` turns of user input + ai response, each ~200 estimated tokens. */
function buildOldTurns(n: number): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(userInputEntry(padded(`old user turn ${i}`)));
    entries.push(aiResponseEntry(padded(`old assistant turn ${i}`)));
  }
  return entries;
}

/** `n` toolcall/toolcallresponse pairs, ~112 estimated tokens each (~12 for the call's JSON,
 * ~100 for the padded response) - no user/response entries around them, so there is no turn
 * boundary anywhere in this history (§2.3's MicroCompact tier exists specifically to still be
 * able to prune within exactly this shape). */
function buildOldToolCallPairs(n: number): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (let i = 0; i < n; i++) {
    const call = { id: `old-call-${i}`, name: 'read_file', input: { path: `f${i}` } };
    entries.push(aiToolCallEntry(call, false));
    entries.push(aiToolCallResponseEntry(call.id, padded(`old tool output ${i}`), false));
  }
  return entries;
}

test('compaction triggers before the turn, hides old entries, keeps the recent tail, and adds a visible summary', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ user_intent: 'build the thing', next_step: 'ship it' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'new answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(8)); // 8 * 2 * TURN_TOKENS = 1600 estimated tokens

  const result = await loop.run('new message', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 }, // threshold = 1400 < 1600
  });

  assert.equal(result, 'new answer');
  assert.equal(provider.callCount, 2); // one compaction call, one real turn call

  const entries = loop.getEntries();
  const compactionEntries = entries.filter((e) => e.type === 'ai' && e.sub_type === 'compaction');
  assert.equal(compactionEntries.length, 1);
  assert.notEqual(compactionEntries[0].agent_visible, false); // the summary itself stays visible

  const hidden = entries.filter((e) => e.agent_visible === false);
  const stillVisibleOld = entries.filter(
    (e) => e.content.startsWith('old ') && e.agent_visible !== false,
  );
  assert.ok(hidden.length > 0, 'expected some old entries to be hidden');
  assert.ok(stillVisibleOld.length > 0, 'expected some recent old-turn entries to survive in the tail');
  assert.ok(hidden.length < buildOldTurns(8).length, 'not literally everything should be hidden');

  // Wire projection: hidden entries' content must not leak through, the summary must, and the
  // new turn's own exchange must still be there.
  const wire = loop.getMessages();
  const wireText = wire.map((m) => m.content).join('\n');
  assert.ok(!wireText.includes(hidden[0].content), "a hidden entry's raw content leaked into the wire projection");
  assert.ok(wireText.includes('build the thing'));
  assert.ok(wireText.includes('new message'));
});

test('compaction call itself gets no tools and a plain-JSON system prompt, separate from the real turn request', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ next_step: 'x' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system prompt text');
  loop.loadEntries(buildOldTurns(8));

  await loop.run('go', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  const [compactionRequest, realRequest] = provider.receivedRequests;
  assert.deepEqual(compactionRequest.tools, []);
  assert.equal(compactionRequest.messages.length, 1);
  assert.equal(compactionRequest.messages[0].role, 'user');
  assert.ok(compactionRequest.systemPrompt?.includes('JSON'));

  assert.equal(realRequest.systemPrompt, 'system prompt text');
});

test('a second compaction seeds itself from the first summary (iterative update, not regenerate)', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ next_step: 'first summary' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer 1', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(8));
  await loop.run('turn A', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  // Pile on enough fresh, large entries that the very next turn is over-threshold again.
  const more = buildOldTurns(6).map((e) => ({ ...e, content: padded(e.content) }));
  loop.loadEntries([...loop.getEntries(), ...more]);

  provider.enqueue(
    { content: JSON.stringify({ next_step: 'second summary' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer 2', toolCalls: [], stopReason: 'end_turn' },
  );

  await loop.run('turn B', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  const secondCompactionRequest = provider.receivedRequests[2];
  assert.ok(secondCompactionRequest.messages[0].content.includes('<previous-summary>'));
  assert.ok(secondCompactionRequest.messages[0].content.includes('first summary'));
});

test('compaction never fires when contextWindow is not provided - existing behavior unchanged', async () => {
  const provider = new FakeProvider([{ content: 'answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(8));

  await loop.run('go');

  assert.equal(provider.callCount, 1); // no compaction call
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
});

test('a failed compaction call is swallowed, and the hard-stop catches the still-oversized content', async () => {
  // Real bug found via direct reproduction (2026-10-02): this fixture (~1600 est. tokens) is
  // already bigger than its own 1500-token window even before the hard-stop existed - previously
  // nothing caught that, so a failed compaction meant sending an oversized request anyway (fine
  // for this FakeProvider, which doesn't enforce size, but a real server would reject it outright
  // - confirmed live, twice, as the exceed_context_size_error that drove this whole fix). The
  // hard-stop now correctly catches this exact case: compaction tried, failed, content still over
  // -> refuse to send rather than let a real server do it for us.
  // Always fails (not just once) - the 2026-10-03 pause-and-compact gate (pauseAndCompactIfOverEighty)
  // retries compaction up to 3 times on its own whenever usage is >=80%, so a summarizer that only
  // failed once would let a retry quietly succeed and defeat this test's actual point (compaction
  // that genuinely never works must still end in a clean hard-stop, not an answer).
  let calls = 0;
  const flaky: LLMProvider = {
    name: 'flaky',
    async complete(_request: CompletionRequest): Promise<CompletionResponse> {
      calls++;
      throw new Error('summarizer is down');
    },
  };
  const loop = new AgentLoop(flaky, [], 'system');
  loop.loadEntries(buildOldTurns(8));

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
    onEvent: (e) => events.push({ type: e.type, text: e.text }),
  });

  assert.equal(result, '', 'the hard-stop ends the turn before any provider call, not with an answer');
  assert.ok(calls >= 1, 'at least the normal compaction call happened - no attempt to send the oversized real request');
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
  assert.equal(loop.getEntries().some((e) => e.agent_visible === false), false); // nothing hidden
  const warning = events.find((e) => e.type === 'warning' && /nearly full/.test(e.text ?? ''));
  assert.ok(warning, 'expected the hard-stop warning once compaction failed to free enough room');
});

test('a single long turn (many tool calls, no new user message in between) compacts mid-turn instead of crashing', async () => {
  // Reproduces the real crash this fix was for: a long research turn's own tool results grow
  // past the context limit entirely on its own, with no new user message to hang a pre-loop
  // check on. Distinguishes the compaction call from a real turn call by `tools.length === 0`
  // (maybeCompact's own request shape, loop.ts) rather than by predicting exact queue
  // positions/token counts by hand - the real trigger is `visibleTokenEstimate`, not a fixed
  // iteration count, so pinning down "iteration N exactly" would make this test as fragile as
  // the arithmetic it's trying to avoid depending on.
  const TOTAL_TOOL_ITERATIONS = 10;
  let toolCallsIssued = 0;
  const provider: LLMProvider = {
    name: 'long-turn',
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      if (request.tools.length === 0) {
        return { content: JSON.stringify({ next_step: 'keep going' }), toolCalls: [], stopReason: 'end_turn' };
      }
      if (toolCallsIssued < TOTAL_TOOL_ITERATIONS) {
        toolCallsIssued += 1;
        return {
          content: `working, step ${toolCallsIssued}`,
          toolCalls: [{ id: `t${toolCallsIssued}`, name: 'big_tool', input: {} }],
          stopReason: 'tool_use',
        };
      }
      return { content: 'final answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const tool = makeFakeTool('big_tool', padded('tool output'));
  const loop = new AgentLoop(provider, [tool], 'system');
  loop.loadEntries(buildOldTurns(6)); // 1200 estimated tokens - a real turn boundary to cut into, but under threshold on its own

  let toolCallsIssuedAtCompaction = -1;
  const result = await loop.run('research this deeply', {
    // Window and reserveTokens scaled up together (same ratio/trigger logic as the original
    // 2000/100) to give the hard-stop's own separate safety margin genuine room below window -
    // see hardStopReserveTokens' own doc comment (2026-10-03 widening) and the two tests above
    // this one for the same test-calibration-collision pattern.
    contextWindow: 4000,
    compactionSettings: {
      reserveTokens: 1900, // tier 3 threshold = 2100, same margin over the ~1200-1700 content range as before
      keepRecentTokens: 300,
      // Disabled (never fires - see shouldCompact()'s formula) so this test stays an isolated
      // regression test for tier 3's mid-turn relocation fix specifically, unaffected by tier 2
      // (MicroCompact) now existing alongside it - that tier gets its own dedicated tests below.
      microCompactReserveTokens: -1_000_000,
    },
    maxIterations: 0, // unlimited - this turn alone needs more than the default 25-iteration cap
    onEntry: (entry) => {
      if (entry.sub_type === 'compaction' && toolCallsIssuedAtCompaction === -1) {
        toolCallsIssuedAtCompaction = toolCallsIssued;
      }
    },
  });

  assert.equal(result, 'final answer');
  assert.equal(toolCallsIssued, TOTAL_TOOL_ITERATIONS); // the whole turn ran to completion, nothing truncated
  assert.ok(
    loop.getEntries().some((e) => e.sub_type === 'compaction'),
    'expected at least one mid-turn compaction to have fired',
  );
  // > 0, not just "happened at some point" - proves it fired only after this turn's own tool
  // calls had already appended new entries, i.e. genuinely mid-turn - not the pre-loop check
  // (which runs before iteration 0, while toolCallsIssued is still 0).
  assert.ok(
    toolCallsIssuedAtCompaction > 0,
    `expected compaction to fire after at least one tool call this turn, got toolCallsIssued=${toolCallsIssuedAtCompaction}`,
  );
});

test('MicroCompact (tier 2) prunes old tool-call pairs for free, hides both entries, keeps the recent tail, and appends exactly one prune marker', async () => {
  const provider = new FakeProvider([{ content: 'answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldToolCallPairs(8)); // ~112 tokens/pair, ~896 total - no turn boundary anywhere

  const result = await loop.run('go', {
    contextWindow: 1000,
    compactionSettings: { reserveTokens: 50, keepRecentTokens: 300, microCompactReserveTokens: 150 },
  });

  assert.equal(result, 'answer');
  assert.equal(provider.callCount, 1); // free tier - no extra summarization call, tier 3 never needed

  const entries = loop.getEntries();
  const pruneEntries = entries.filter((e) => e.type === 'ai' && e.sub_type === 'prune');
  assert.equal(pruneEntries.length, 1); // one marker per pass, not one per pruned pair
  assert.notEqual(pruneEntries[0].agent_visible, false); // the marker itself stays visible

  const calls = entries.filter((e) => e.sub_type === 'toolcall');
  const hidden = calls.filter((e) => e.agent_visible === false);
  const stillVisible = calls.filter((e) => e.agent_visible !== false);
  assert.ok(hidden.length > 0, 'expected some old pairs to be pruned');
  assert.ok(stillVisible.length > 0, 'expected some recent pairs to survive');

  // Every pair is fully hidden or fully visible together, never split - a split pair would leave
  // a dangling tool_use/tool_result in the wire projection.
  for (const call of calls) {
    const response = entries.find((e) => e.sub_type === 'toolcallresponse' && e.tool_call_id === call.tool_call_id);
    assert.equal(call.agent_visible === false, response?.agent_visible === false, `pair ${call.tool_call_id} split across visibility`);
  }

  const wire = loop.getMessages();
  const wireText = wire.map((m) => m.content).join('\n');
  for (const call of hidden) {
    const response = entries.find((e) => e.sub_type === 'toolcallresponse' && e.tool_call_id === call.tool_call_id);
    assert.ok(response && !wireText.includes(response.content), "a hidden pair's content leaked into the wire projection");
  }
});

test('MicroCompact rescues a single turn with no earlier turn boundary at all - the exact gap tier 3 alone cannot close', async () => {
  // Reproduces probe-compaction.ts's scenario A/B directly: one turn, no second user message ever,
  // so findCutPoint() has no boundary to snap to and would return 0 forever - confirmed separately
  // in compaction.test.ts. This is what tier 2 is actually for.
  const TOTAL_TOOL_ITERATIONS = 20;
  let toolCallsIssued = 0;
  const provider: LLMProvider = {
    name: 'no-boundary',
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      if (request.tools.length === 0) {
        // tier 3's own request shape - reaching this at all would mean tier 2 failed to keep this
        // turn under tier 3's (much higher) threshold on its own.
        return { content: JSON.stringify({ next_step: 'x' }), toolCalls: [], stopReason: 'end_turn' };
      }
      if (toolCallsIssued < TOTAL_TOOL_ITERATIONS) {
        toolCallsIssued += 1;
        return {
          content: '',
          toolCalls: [{ id: `t${toolCallsIssued}`, name: 'big_tool', input: {} }],
          stopReason: 'tool_use',
        };
      }
      return { content: 'final answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const tool = makeFakeTool('big_tool', padded('tool output'));
  const loop = new AgentLoop(provider, [tool], 'system');
  // No loadEntries() - this turn's own opening user message is the only thing in history when it
  // starts.

  let maxVisible = 0;
  const result = await loop.run('research this deeply', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 50, keepRecentTokens: 300, microCompactReserveTokens: 400 },
    maxIterations: 0,
    onEntry: () => {
      maxVisible = Math.max(maxVisible, loop.getVisibleTokenEstimate());
    },
  });

  assert.equal(result, 'final answer');
  assert.equal(toolCallsIssued, TOTAL_TOOL_ITERATIONS); // the whole turn ran to completion
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'prune'), 'expected MicroCompact to have pruned at least once');
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false); // tier 3 never needed to fire
  // Without tier 2, this exact shape grows to ~20 * 112 ≈ 2240 tokens with zero chance to shrink
  // (findCutPoint always returns 0 here) - bounded growth, not "never crossed the window even
  // once," is the actual claim: tier 2 only fires once it's already past its own threshold.
  assert.ok(maxVisible < 2000, `peak visible ${maxVisible} grew essentially unbounded - MicroCompact failed to cap it`);
});

test('MicroCompact never splits a toolcall from its toolcallresponse even when the raw cutoff lands between them', async () => {
  // The bug found and fixed while writing this test: microCompactCutoffIndex() doesn't snap to a
  // turn boundary (that's the whole point - see its own doc comment), so the raw cutoff can land
  // exactly between a pair. Engineered directly: the middle pair's response alone is large enough
  // that the backward walk crosses keepRecentTokens while sitting on the call, landing the cutoff
  // exactly at the response's own index.
  const provider = new FakeProvider([{ content: 'answer', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  const call0 = { id: 'c0', name: 'read_file', input: {} };
  const call1 = { id: 'c1', name: 'read_file', input: {} };
  const call2 = { id: 'c2', name: 'read_file', input: {} };
  loop.loadEntries([
    aiToolCallEntry(call0, false),
    aiToolCallResponseEntry(call0.id, padded('small old output'), false), // ~100 tokens
    aiToolCallEntry(call1, false),
    aiToolCallResponseEntry(call1.id, 'y'.repeat(2400), false), // ~600 tokens - deliberately huge
    aiToolCallEntry(call2, false),
    aiToolCallResponseEntry(call2.id, padded('small recent output'), false), // ~100 tokens
  ]);

  await loop.run('go', {
    contextWindow: 10_000,
    compactionSettings: { reserveTokens: 1, keepRecentTokens: 500, microCompactReserveTokens: 9999 },
  });

  const entries = loop.getEntries();
  const callEntry = (id: string) => entries.find((e) => e.tool_call_id === id && e.sub_type === 'toolcall');
  const responseEntry = (id: string) => entries.find((e) => e.tool_call_id === id && e.sub_type === 'toolcallresponse');

  assert.equal(callEntry('c0')?.agent_visible, false); // old, small pair - safely prunable
  assert.equal(responseEntry('c0')?.agent_visible, false);

  // The pair the raw (unsnapped) cutoff lands inside of - correctly left fully visible (its real
  // response size means it isn't actually old enough once accounted for), never split.
  assert.notEqual(callEntry('c1')?.agent_visible, false);
  assert.notEqual(responseEntry('c1')?.agent_visible, false);

  assert.notEqual(callEntry('c2')?.agent_visible, false);
  assert.notEqual(responseEntry('c2')?.agent_visible, false);
});

test('maybeCompact caps its own summarization prompt so an oversized region cannot fail the call outright', async () => {
  // Reproduces probe-compaction.ts's scenario C through the real path (maybeCompact() deriving
  // maxContentChars from its own settings.reserveTokens), not by calling buildCompactionPrompt()
  // directly - a region built of many large tool outputs has no upper bound of its own, and
  // without the cap the resulting prompt would be large enough to fail outright (simulated here
  // as the fake provider throwing past a size it treats as "too big for the window"), silently
  // swallowed by maybeCompact()'s own best-effort catch with no compaction ever happening.
  const MAX_REALISTIC_PROMPT_CHARS = 20_000; // stands in for "would exceed the real model window"
  let compactionRequestContentLength = -1;
  const provider: LLMProvider = {
    name: 'size-sensitive',
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      if (request.tools.length === 0) {
        compactionRequestContentLength = request.messages[0].content.length;
        if (compactionRequestContentLength > MAX_REALISTIC_PROMPT_CHARS) {
          throw new Error('prompt too large for context window');
        }
        return { content: JSON.stringify({ next_step: 'x' }), toolCalls: [], stopReason: 'end_turn' };
      }
      return { content: 'answer', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  // A registered (if unused) tool, so the real turn's own request has tools.length > 0 -
  // distinguishing it from the compaction call's tools:[] shape, same as maybeCompact()'s own
  // request does in real code (loop.ts).
  const loop = new AgentLoop(provider, [makeFakeTool('unused_tool', 'n/a')], 'system');
  // 30 turns, each padded well past a size that would make the raw, uncapped region's serialized
  // text (~30 * ~1000+ chars) exceed MAX_REALISTIC_PROMPT_CHARS on its own.
  // Starts with a SHORT user turn because the first user/input is pinned (never hidden, never
  // released - see `AgentLoop.pinnedEntryId()`). These deliberately tiny windows make a padded
  // ~1,000-char first turn a permanent 12-20% of the budget, which hard-stops the turn before it
  // can reach what this test is actually about (the summarization prompt's own cap). A real task
  // prompt is small next to the history it accumulates, so a short one is also the realistic shape.
  const entries: ContextEntry[] = [userInputEntry('go')];
  for (let i = 0; i < 30; i++) {
    entries.push(userInputEntry(`turn ${i} ${'x'.repeat(996)}`)); // ~1000 chars each
    entries.push(aiResponseEntry(`resp ${i} ${'y'.repeat(996)}`));
  }
  loop.loadEntries(entries); // ~30,000 raw chars in the region a compaction would try to fold away

  const result = await loop.run('go', {
    contextWindow: 2000,
    // reserveTokens=3000 -> maxContentChars = floor(3000*0.7)*4 = 8400, comfortably under
    // MAX_REALISTIC_PROMPT_CHARS once capped, nowhere close to it uncapped.
    compactionSettings: { reserveTokens: 3000, keepRecentTokens: 500 },
  });

  assert.equal(result, 'answer');
  assert.ok(compactionRequestContentLength > 0, 'expected the compaction call to actually be attempted');
  assert.ok(
    compactionRequestContentLength <= MAX_REALISTIC_PROMPT_CHARS,
    `compaction prompt was ${compactionRequestContentLength} chars - the cap did not actually bound it`,
  );
  assert.ok(
    loop.getEntries().some((e) => e.sub_type === 'compaction'),
    'expected compaction to actually succeed, not be silently swallowed by an oversized prompt',
  );
});

test('the compaction trigger accounts for system-prompt + tool-schema overhead, not just entry content', async () => {
  // Real gap found via direct probe (probe-compaction.ts scenario E): visibleTokenEstimate alone
  // (entry content only) stayed under threshold while the true request - system prompt + every
  // tool's JSON schema, identical on every single call - was already over it. The trigger fired
  // later than the real request size, eating into reserveTokens' own margin.
  const bigSystemPrompt = 'x'.repeat(6000); // ~1500 estimated tokens - not in visibleTokenEstimate at all
  const provider = new FakeProvider([
    { content: JSON.stringify({ next_step: 'x' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const tool = makeFakeTool('read_file', 'contents');
  const loop = new AgentLoop(provider, [tool], bigSystemPrompt);
  loop.loadEntries(buildOldTurns(3)); // ~600 estimated tokens of entry content - under threshold on its own

  const result = await loop.run('go', {
    // Window and reserveTokens both scaled up together from the original 2000/100 (same ratio,
    // same trigger-threshold logic) to give the hard-stop's own, separate safety margin (2026-10-03
    // widening, see hardStopReserveTokens' own doc comment) genuine room below window - this test's
    // fixed ~1500-token system-prompt overhead plus a small post-compact tail was colliding with
    // that margin at the original small scale, which was a test-calibration collision, not a real
    // regression (see the two tests directly above this one for the same pattern/explanation).
    contextWindow: 3500,
    // threshold = 1900, same as before. Entry content alone (600) stays under it - only counting
    // the system prompt's overhead too (600 + ~1500 = ~2100) crosses it, which is the actual point
    // of this test: without the fix, this would never have fired at all.
    compactionSettings: { reserveTokens: 1600, keepRecentTokens: 50 },
  });

  assert.equal(result, 'answer');
  assert.equal(provider.callCount, 2); // one compaction call, one real turn call - it DID fire
  assert.ok(
    loop.getEntries().some((e) => e.sub_type === 'compaction'),
    'expected the overhead-aware trigger to fire even though entry content alone was under threshold',
  );
});

test('the compaction trigger picks up a per-request modeInstruction as overhead too', async () => {
  const provider = new FakeProvider([
    { content: JSON.stringify({ next_step: 'x' }), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system'); // small, fixed system prompt this time
  loop.loadEntries(buildOldTurns(3)); // ~600 tokens

  const result = await loop.run('go', {
    // Scaled up with reserveTokens together, same reasoning as the test directly above this one.
    contextWindow: 3500, // threshold = 1900 (same settings as above)
    compactionSettings: { reserveTokens: 1600, keepRecentTokens: 50 },
    modeInstruction: 'x'.repeat(6000), // ~1500 tokens, appended onto the small fixed system prompt
  });

  assert.equal(result, 'answer');
  assert.ok(
    loop.getEntries().some((e) => e.sub_type === 'compaction'),
    'expected modeInstruction to count toward the overhead estimate, same as the fixed system prompt',
  );
});

test('a compaction whose generated summary would cost more than it removes is declined, not applied', async () => {
  // Real flaw found via direct hands-on observation, not just probing: a small compactable
  // region can generate a summary LARGER than what it replaces - the structured JSON summary
  // (user_intent/technical_concepts/files/errors_and_fixes/etc.) has its own baseline size, so
  // folding away just a couple of small entries can make visibleTokenEstimate go UP, not down.
  const verboseSummary = { current_work: 'x'.repeat(3000) }; // serializes far larger than the ~400-token region it'd replace
  // Two copies queued (not one) - the 2026-10-03 pause-and-compact gate makes one extra compaction
  // attempt of its own (on top of the normal per-round one) whenever usage is still >=80% after
  // that first attempt, which this fixture's overshoot (~600 tokens against a 500 window) is. Both
  // attempts decline the same way, so no real progress is ever made and the retry loop gives up
  // after that - the 'answer' entry is never reached either way (the hard-stop below).
  const provider = new FakeProvider([
    { content: JSON.stringify(verboseSummary), toolCalls: [], stopReason: 'end_turn' },
    { content: JSON.stringify(verboseSummary), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(3)); // 3 turns, ~200 tokens each = ~600 total

  // Real bug found via direct reproduction (2026-10-02): this fixture (~600 est. tokens) is
  // already bigger than its own 500-token window before anything happens. A declined compaction
  // leaves it that way, so the hard-stop now correctly ends the turn before the second ("answer")
  // provider call would ever be reached - same reasoning as the failed-compaction test above.
  const beforeVisible = loop.getVisibleTokenEstimate();
  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', {
    contextWindow: 500,
    compactionSettings: { reserveTokens: 50, keepRecentTokens: 10 }, // threshold=450 < 600, tiny keep budget
    onEvent: (e) => events.push({ type: e.type, text: e.text }),
  });

  assert.equal(result, '', 'the hard-stop ends the turn before the real-answer provider call');
  // Compaction WAS attempted (normal round + one forced pause-and-compact retry, both declined) -
  // the hard-stop then stops before the real-answer call would happen.
  assert.equal(provider.callCount, 2);
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
  assert.equal(loop.getEntries().some((e) => e.agent_visible === false), false); // nothing hidden
  assert.ok(
    loop.getVisibleTokenEstimate() >= beforeVisible,
    'expected an unhelpful compaction to leave visibleTokenEstimate unchanged, not smaller',
  );
  const warning = events.find((e) => e.type === 'warning' && /nearly full/.test(e.text ?? ''));
  assert.ok(warning, 'expected the hard-stop warning once the declined compaction left content still over window');
});

test('pause-and-compact: at >=80% usage, compacts down near the 75% target before sending, with no hard-stop needed', async () => {
  // Per direct instruction (2026-10-03): the positive path for pauseAndCompactIfOverEighty -
  // content starts above the 80% pause threshold but below the (separate, higher) hard-stop
  // threshold, compaction genuinely succeeds in shrinking it, and the real turn proceeds normally
  // with no warning/hard-stop at all. Distinct from the two tests above, which cover compaction
  // failing/declining and the hard-stop catching that - this one proves the gate's actual job
  // (proactively keeping things well clear of the edge) when compaction CAN do its job.
  const tinySummary = { current_work: 'x' }; // genuinely tiny - real shrink, not a decline case
  const provider = new FakeProvider([
    { content: JSON.stringify(tinySummary), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(16)); // ~3200 estimated tokens

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', {
    contextWindow: 4000, // 80% = 3200 (just crossed), 75% target = 3000, hard-stop threshold = 3400
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 200 },
    onEvent: (e) => events.push({ type: e.type, text: e.text }),
  });

  assert.equal(result, 'answer', 'the real turn completes normally once compaction brought usage back down');
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'compaction'), 'expected the pause-and-compact gate to have applied a real compaction');
  assert.ok(
    loop.getVisibleTokenEstimate() < 4000 * 0.75,
    'expected usage to land at or below the 75% target after a successful forced compaction',
  );
  assert.equal(
    events.some((e) => e.type === 'warning' && /nearly full/.test(e.text ?? '')),
    false,
    'the hard-stop should never fire when the pause-and-compact gate already did its job',
  );
});

test('a compaction whose generated summary genuinely shrinks a small region is still applied', async () => {
  // The counterpart to the test above - the guard must not block a real, legitimate net win just
  // because the region happens to be small; only decline when the summary itself is the problem.
  const tinySummary = { next_step: 'x' }; // serializes far smaller than the region it replaces
  const provider = new FakeProvider([
    { content: JSON.stringify(tinySummary), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  // Short leading user turn: the first user/input is pinned (`AgentLoop.pinnedEntryId()`), and at a
  // 500-token window one of `buildOldTurns`' 400-char turns would hold 20% of the budget forever -
  // enough to hard-stop this turn after a perfectly good compaction had already been applied.
  loop.loadEntries([userInputEntry('go'), ...buildOldTurns(3)]);

  const result = await loop.run('go', {
    contextWindow: 500,
    compactionSettings: { reserveTokens: 50, keepRecentTokens: 10 },
  });

  assert.equal(result, 'answer');
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'compaction'), 'expected a genuinely helpful compaction to be applied');
});

test('the hybrid real+delta estimate catches an overflow a pure char-estimate would miss - the actual root cause of the live near-miss', async () => {
  // Real bug found via direct reproduction (2026-10-02): a live run sent a request at 57,346
  // tokens against a 57,344-token server limit - only 2 tokens over, because our char/4 estimate
  // slightly under-counted. Verified against real Claude Code's own source
  // (tokenCountWithEstimation, src/utils/tokens.ts): anchor on the last real usage.inputTokens,
  // add only the estimated delta since - bounds the error to just the newest content instead of
  // re-estimating the whole history from scratch every time. This test proves the mechanism:
  // the fixture's actual char content is tiny (a pure estimate would stay far under the window),
  // but the FIRST response's reported real usage is deliberately much higher (simulating the real
  // tokenizer disagreeing with our rough guess, exactly what happened live) - the hard-stop must
  // fire on round 2 using that real number, something a pure-estimate-only check would never catch.
  const tool = makeFakeTool('read_file', 'ok');
  const provider = new FakeProvider([
    {
      content: '',
      toolCalls: [{ id: 't1', name: 'read_file', input: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 950, outputTokens: 5 }, // far above what chars/4 of 'go' would estimate
    },
    { content: 'should never be reached', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [tool], 'system');

  const events: Array<{ type: string; text?: string }> = [];
  const result = await loop.run('go', {
    contextWindow: 1000, // hard-stop reserve = min(3000, 100) = 100 -> threshold 900
    onEvent: (e) => events.push({ type: e.type, text: e.text }),
  });

  assert.equal(result, '', 'the hard-stop should end the turn after round 1, using the real usage number');
  assert.equal(provider.callCount, 1, 'round 2 ("should never be reached") must not be sent');
  const warning = events.find((e) => e.type === 'warning' && /nearly full/.test(e.text ?? ''));
  assert.ok(warning, 'expected the hard-stop warning, driven by the real usage count not the char estimate');
});

test('tier-3 summarization fires inside a single tool-heavy turn with no user boundary (2026-10-04)', async () => {
  // Real bug: a long single turn has no user message after the first, so the turn-boundary-only
  // cut rule meant real summarization could never fire there, and reasoning/response growth ran
  // straight to the hard-stop. Tool rounds are now valid cut points, so tier 3 must act here.
  const tinySummary = { current_work: 'x' };
  const provider = new FakeProvider([
    { content: JSON.stringify(tinySummary), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldToolCallPairs(40)); // one turn, no second user message anywhere

  const result = await loop.run('go', {
    contextWindow: 4000,
    compactionSettings: {
      reserveTokens: 500,
      keepRecentTokens: 500,
      // Tier 2 disabled so this isolates tier 3 - the path under test.
      microCompactReserveTokens: -1_000_000,
    },
  });

  assert.equal(result, 'answer');
  assert.ok(
    loop.getEntries().some((e) => e.sub_type === 'compaction'),
    'expected a real summarization compaction to fire inside the single turn',
  );
});

// The recovery path for history that predates the tool-output cap. The 2026-10-06 runs left an
// 11.4 MB session on disk: one toolcallresponse of ~2.8M tokens against a 229,376-token window. The
// age-based pass structurally cannot touch it - keepRecentTokens protects the newest entries, and
// that entry IS the newest - so MicroCompact freed 29 tokens while the real offender sat untouched
// and the pre-turn hard stop refused every subsequent turn. See pruneOversizedToolResults().
test('an oversized tool result is pruned however recent it is, so a wedged session can run again', async () => {
  const provider = new FakeProvider([{ content: 'recovered', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  const call = aiToolCallEntry({ id: 't1', name: 'run_shell', input: { command: 'dir /s /b' } });
  const huge = aiToolCallResponseEntry('t1', 'x'.repeat(2_000_000)); // ~500K tokens, 229K window
  loop.loadEntries([userInputEntry('walk the tree'), call, huge]);
  const before = loop.getVisibleTokenEstimate();
  assert.ok(before > 229_376, `fixture must start over the window, was ${before}`);

  const events: string[] = [];
  const result = await loop.run('carry on', {
    contextWindow: 229_376,
    onEvent: (e) => { if (e.type === 'prune' || e.type === 'warning') events.push(`${e.type}: ${e.text}`); },
  });

  assert.equal(result, 'recovered', 'the turn runs instead of hard-stopping');
  assert.ok(loop.getVisibleTokenEstimate() < 229_376, `still over the window: ${loop.getVisibleTokenEstimate()}`);
  assert.ok(events.some((e) => e.startsWith('prune:') && e.includes('oversized tool result')), events.join(' | '));
  assert.ok(!events.some((e) => e.startsWith('warning:')), `expected no hard stop, got: ${events.join(' | ')}`);
});

test('pruning an oversized result hides its tool call too, so the request stays well-formed', async () => {
  const provider = new FakeProvider([{ content: 'ok', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  loop.loadEntries([
    userInputEntry('go'),
    aiToolCallEntry({ id: 't1', name: 'run_shell', input: { command: 'dir /s /b' } }),
    aiToolCallResponseEntry('t1', 'y'.repeat(2_000_000)),
  ]);

  await loop.run('next', { contextWindow: 229_376 });

  const entries = loop.getEntries();
  const call = entries.find((e) => e.sub_type === 'toolcall');
  const response = entries.find((e) => e.sub_type === 'toolcallresponse');
  assert.equal(call?.agent_visible, false, 'the call must be hidden with its response');
  assert.equal(response?.agent_visible, false);

  // A visible tool call with no visible answer would be a malformed request - the thing the
  // context-window suite's own call-has-result invariant checks for.
  const sent = provider.receivedRequests[0].messages;
  const openCalls = sent.filter((m) => m.toolCalls && m.toolCalls.length > 0).length;
  assert.equal(openCalls, 0, 'no dangling tool call reached the wire');
});

test('a tool result merely near the budget is left alone - this is not a second truncation tier', async () => {
  const provider = new FakeProvider([{ content: 'ok', toolCalls: [], stopReason: 'end_turn' }]);
  const loop = new AgentLoop(provider, [], 'system');

  // 60,000 chars = 15,000 tokens: over the 10,000-token budget, under the 2x prune threshold.
  const nearLimit = aiToolCallResponseEntry('t1', 'z'.repeat(60_000));
  loop.loadEntries([userInputEntry('go'), aiToolCallEntry({ id: 't1', name: 'read_file', input: {} }), nearLimit]);

  await loop.run('next', { contextWindow: 229_376 });

  const response = loop.getEntries().find((e) => e.sub_type === 'toolcallresponse');
  assert.notEqual(response?.agent_visible, false, 'a merely large result must survive');
  assert.equal(response?.content.length, 60_000, 'and keep its content');
});
