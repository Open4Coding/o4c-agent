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

test('a failed compaction call is swallowed - the turn itself still proceeds normally', async () => {
  let calls = 0;
  const flaky: LLMProvider = {
    name: 'flaky',
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      calls++;
      if (calls === 1) throw new Error('summarizer is down');
      return { content: 'answer despite the failed compaction', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const loop = new AgentLoop(flaky, [], 'system');
  loop.loadEntries(buildOldTurns(8));

  const result = await loop.run('go', {
    contextWindow: 1500,
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 500 },
  });

  assert.equal(result, 'answer despite the failed compaction');
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
  assert.equal(loop.getEntries().some((e) => e.agent_visible === false), false); // nothing hidden
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
    contextWindow: 2000,
    compactionSettings: {
      reserveTokens: 100, // tier 3 threshold = 1900
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
  const entries: ContextEntry[] = [];
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
    contextWindow: 2000,
    // threshold = 1900. Entry content alone (600) stays under it - only counting the system
    // prompt's overhead too (600 + ~1500 = ~2100) crosses it, which is the actual point of this
    // test: without the fix, this would never have fired at all.
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 50 },
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
    contextWindow: 2000, // threshold = 1900 (same settings as above)
    compactionSettings: { reserveTokens: 100, keepRecentTokens: 50 },
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
  const provider = new FakeProvider([
    { content: JSON.stringify(verboseSummary), toolCalls: [], stopReason: 'end_turn' },
    { content: 'answer', toolCalls: [], stopReason: 'end_turn' },
  ]);
  const loop = new AgentLoop(provider, [], 'system');
  loop.loadEntries(buildOldTurns(3)); // 3 turns, ~200 tokens each = ~600 total

  const beforeVisible = loop.getVisibleTokenEstimate();
  const result = await loop.run('go', {
    contextWindow: 500,
    compactionSettings: { reserveTokens: 50, keepRecentTokens: 10 }, // threshold=450 < 600, tiny keep budget
  });

  assert.equal(result, 'answer');
  // The compaction WAS attempted (the provider call happened), but its result was declined.
  assert.equal(provider.callCount, 2);
  assert.equal(loop.getEntries().some((e) => e.sub_type === 'compaction'), false);
  assert.equal(loop.getEntries().some((e) => e.agent_visible === false), false); // nothing hidden
  assert.ok(
    loop.getVisibleTokenEstimate() >= beforeVisible,
    'expected an unhelpful compaction to leave visibleTokenEstimate unchanged, not smaller',
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
  loop.loadEntries(buildOldTurns(3));

  const result = await loop.run('go', {
    contextWindow: 500,
    compactionSettings: { reserveTokens: 50, keepRecentTokens: 10 },
  });

  assert.equal(result, 'answer');
  assert.ok(loop.getEntries().some((e) => e.sub_type === 'compaction'), 'expected a genuinely helpful compaction to be applied');
});
