import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { aiResponseEntry, userInputEntry, type ContextEntry } from '../agent/contextEntry.js';
import { CoreRegistry, type CoreComponent } from '../agent/coreSeam.js';
import { FakeProvider } from './fakeProvider.js';
import { makeFakeTool } from './fakeTool.js';
import type { Tool } from '../tools/types.js';

/**
 * The core tier's seam - design doc §5.7. Covers the three hook points, the two invariants that
 * make the seam safe (projection not mutation; the approval gate stays in front of tool
 * interception) and the degradation behaviour each hook was given on purpose.
 *
 * Nothing registers on this seam in the shipped product yet. These tests are what says it works
 * before items 13/22/23/40 are built on top of it.
 */

function endTurn(content = 'done'): FakeProvider {
  return new FakeProvider([{ content, toolCalls: [], stopReason: 'end_turn' }]);
}

/** Runs a turn and collects the warnings the seam emitted. */
async function runCollectingWarnings(
  loop: AgentLoop,
  message = 'hello',
): Promise<{ result: string; warnings: string[] }> {
  const warnings: string[] = [];
  const result = await loop.run(message, {
    onEvent: (event: AgentEvent) => {
      if (event.type === 'warning' && event.text) warnings.push(event.text);
    },
  });
  return { result, warnings };
}

// ---------------------------------------------------------------------------------------------
// Hook 1 - entry appended
// ---------------------------------------------------------------------------------------------

test('a registered component observes appended entries, and the caller\'s own onEntry still fires', async () => {
  const seen: string[] = [];
  const loop = new AgentLoop(endTurn(), [], 'system');
  loop.registerCore({ name: 'observer', onEntry: (e) => seen.push(`${e.type}/${e.sub_type}`) });

  const callerSaw: string[] = [];
  await loop.run('hello', { onEntry: (e) => callerSaw.push(`${e.type}/${e.sub_type}`) });

  assert.deepEqual(seen, ['user/input', 'ai/response']);
  // The caller's hook is session persistence - adding a component must not displace it.
  assert.deepEqual(callerSaw, seen);
});

test('a throwing entry observer is caught: the turn finishes, a warning names it, later observers still run', async () => {
  const later: string[] = [];
  const loop = new AgentLoop(endTurn(), [], 'system');
  loop.registerCore({
    name: 'broken-store',
    onEntry: () => {
      throw new Error('disk full');
    },
  });
  loop.registerCore({ name: 'healthy', onEntry: (e) => later.push(e.sub_type) });

  const { result, warnings } = await runCollectingWarnings(loop);

  assert.equal(result, 'done');
  assert.ok(later.length > 0, 'a later observer must still be notified');
  assert.ok(
    warnings.some((w) => w.includes('broken-store') && w.includes('disk full')),
    `warning should name the component and the cause, got ${JSON.stringify(warnings)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Hook 2 - request construction
// ---------------------------------------------------------------------------------------------

test('with no request hook the wire messages are exactly the unhooked projection', async () => {
  // The vacuity guard for every test below: if the seam changed the default path, the assertions
  // about hooks changing it would prove nothing.
  const bare = new FakeProvider([{ content: 'done', toolCalls: [], stopReason: 'end_turn' }]);
  const bareLoop = new AgentLoop(bare, [], 'system');
  await bareLoop.run('hello');

  const seamed = new FakeProvider([{ content: 'done', toolCalls: [], stopReason: 'end_turn' }]);
  const seamedLoop = new AgentLoop(seamed, [], 'system');
  seamedLoop.registerCore({ name: 'does-nothing' }); // registered, but implements no hook
  await seamedLoop.run('hello');

  assert.deepEqual(seamed.receivedRequests[0].messages, bare.receivedRequests[0].messages);
});

test('a request hook decides what goes on the wire', async () => {
  const provider = endTurn();
  const loop = new AgentLoop(provider, [], 'system');
  loop.registerCore({
    name: 'drops-everything',
    buildRequest: () => [userInputEntry('replaced by the hook')],
  });

  await loop.run('the real user message');

  const sent = provider.receivedRequests[0].messages;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'replaced by the hook');
  assert.ok(
    !JSON.stringify(sent).includes('the real user message'),
    'the hook returned a list without it, so it must not reach the provider',
  );
});

test('a request hook may inject an entry that was never in history, and history is NOT mutated', async () => {
  // The core invariant of §5.7: projection, not mutation. A retrieved entry lives for exactly one
  // request, which is the correct lifetime for a retrieval result.
  const provider = endTurn();
  const loop = new AgentLoop(provider, [], 'system');
  const retrieved = aiResponseEntry('recalled from the infinite-context store');
  loop.registerCore({
    name: 'fake-retrieval',
    buildRequest: ({ entries }) => [retrieved, ...entries],
  });

  await loop.run('hello');

  const sent = provider.receivedRequests[0].messages;
  assert.ok(
    JSON.stringify(sent).includes('recalled from the infinite-context store'),
    'the injected entry must reach the provider',
  );
  const liveIds = loop.getEntries().map((e) => e.id);
  assert.ok(!liveIds.includes(retrieved.id), 'the injected entry must NOT be appended to history');
  // And the loop's own accounting is untouched by it.
  assert.deepEqual(
    loop.getEntries().map((e) => e.sub_type),
    ['input', 'response'],
  );
});

test('request hooks are a pipeline in registration order', async () => {
  const provider = endTurn();
  const loop = new AgentLoop(provider, [], 'system');
  const order: string[] = [];
  loop.registerCore({
    name: 'first',
    buildRequest: ({ entries }) => {
      order.push('first');
      return [...entries, userInputEntry('added by first')];
    },
  });
  loop.registerCore({
    name: 'second',
    buildRequest: ({ entries }) => {
      order.push('second');
      // Proves the second hook sees the FIRST hook's output, not the loop's own history.
      assert.ok(
        entries.some((e) => e.content === 'added by first'),
        'second hook must receive the first hook\'s result',
      );
      return [...entries, userInputEntry('added by second')];
    },
  });

  await loop.run('hello');

  assert.deepEqual(order, ['first', 'second']);
  const text = JSON.stringify(provider.receivedRequests[0].messages);
  assert.ok(text.includes('added by first') && text.includes('added by second'));
});

test('a throwing request hook degrades to the value before it, and the turn still succeeds', async () => {
  const provider = endTurn();
  const loop = new AgentLoop(provider, [], 'system');
  loop.registerCore({
    name: 'good',
    buildRequest: ({ entries }) => [...entries, userInputEntry('survived')],
  });
  loop.registerCore({
    name: 'explodes',
    buildRequest: () => {
      throw new Error('index corrupt');
    },
  });

  const { result, warnings } = await runCollectingWarnings(loop);

  assert.equal(result, 'done');
  assert.ok(
    JSON.stringify(provider.receivedRequests[0].messages).includes('survived'),
    'the healthy hook\'s contribution must be kept',
  );
  assert.ok(warnings.some((w) => w.includes('explodes') && w.includes('index corrupt')), String(warnings));
});

test('a request hook returning a non-array is ignored rather than coerced', async () => {
  const provider = endTurn();
  const loop = new AgentLoop(provider, [], 'system');
  loop.registerCore({
    name: 'forgot-to-return',
    // The realistic way to get here: an async hook with a missing `return`.
    buildRequest: (() => undefined) as unknown as CoreComponent['buildRequest'],
  });

  const { result, warnings } = await runCollectingWarnings(loop);

  assert.equal(result, 'done');
  // Falls back to real history rather than sending an empty conversation.
  assert.ok(JSON.stringify(provider.receivedRequests[0].messages).includes('hello'));
  assert.ok(warnings.some((w) => w.includes('forgot-to-return')), String(warnings));
});

test('a request hook is given the context window and this request\'s max tokens', async () => {
  const provider = endTurn();
  const loop = new AgentLoop(provider, [], 'system');
  const seen: Array<{ contextWindow?: number; maxTokens?: number }> = [];
  loop.registerCore({
    name: 'budget-reader',
    buildRequest: ({ entries, contextWindow, maxTokens }) => {
      seen.push({ contextWindow, maxTokens });
      return entries;
    },
  });

  await loop.run('hello', { contextWindow: 100_000 });

  // Twice per turn since the token accounting started measuring this projection: once for the
  // pre-turn compaction decision and once for the request, with the user's own message landing
  // between them. `seamAccounting.test.ts` pins that count and explains it.
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.contextWindow === 100_000));
  // A hook cannot budget retrieval without knowing what the response is already allowed. This is
  // the per-response *ceiling* rather than the figure the request will carry - see
  // `refreshRequestProjection` for why that is the conservative half of a circular dependency.
  assert.ok(seen.every((s) => typeof s.maxTokens === 'number'));
});

// ---------------------------------------------------------------------------------------------
// Hook 3 - tool dispatch
// ---------------------------------------------------------------------------------------------

function toolCallThenEnd(toolName: string): FakeProvider {
  return new FakeProvider([
    { content: 'calling', toolCalls: [{ id: 't1', name: toolName, input: { q: 'x' } }], stopReason: 'tool_use' },
    { content: 'done', toolCalls: [], stopReason: 'end_turn' },
  ]);
}

test('a tool hook can answer a call without the tool ever executing', async () => {
  const grep = makeFakeTool('grep', 'REAL FILE SCAN');
  const loop = new AgentLoop(toolCallThenEnd('grep'), [grep], 'system');
  const results: string[] = [];
  loop.registerCore({
    name: 'code-graph',
    aroundTool: async () => 'answered from the graph',
  });

  await loop.run('find it', {
    onEvent: (e) => {
      if (e.type === 'tool_result' && e.toolOutput) results.push(e.toolOutput);
    },
  });

  assert.deepEqual(grep.calls, [], 'the real tool must not run when the hook answered');
  assert.deepEqual(results, ['answered from the graph']);
});

test('a tool hook that calls next() gets the real result and can transform it', async () => {
  const grep = makeFakeTool('grep', 'real output');
  const loop = new AgentLoop(toolCallThenEnd('grep'), [grep], 'system');
  const results: string[] = [];
  loop.registerCore({
    name: 'passthrough',
    aroundTool: async (_call, next) => `[wrapped] ${await next()}`,
  });

  await loop.run('find it', {
    onEvent: (e) => {
      if (e.type === 'tool_result' && e.toolOutput) results.push(e.toolOutput);
    },
  });

  assert.equal(grep.calls.length, 1, 'next() must reach the real tool');
  assert.deepEqual(results, ['[wrapped] real output']);
});

test('the first registered tool hook is the outermost wrapper', async () => {
  const grep = makeFakeTool('grep', 'core');
  const loop = new AgentLoop(toolCallThenEnd('grep'), [grep], 'system');
  const results: string[] = [];
  loop.registerCore({ name: 'outer', aroundTool: async (_c, next) => `outer(${await next()})` });
  loop.registerCore({ name: 'inner', aroundTool: async (_c, next) => `inner(${await next()})` });

  await loop.run('find it', {
    onEvent: (e) => {
      if (e.type === 'tool_result' && e.toolOutput) results.push(e.toolOutput);
    },
  });

  assert.deepEqual(results, ['outer(inner(core))']);
});

test('a tool hook is told which tool and input it is wrapping', async () => {
  const grep = makeFakeTool('grep', 'real output');
  const loop = new AgentLoop(toolCallThenEnd('grep'), [grep], 'system');
  const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
  loop.registerCore({
    name: 'inspector',
    aroundTool: async (call, next) => {
      seen.push({ name: call.tool.name, input: call.input });
      return next();
    },
  });

  await loop.run('find it');

  assert.deepEqual(seen, [{ name: 'grep', input: { q: 'x' } }]);
});

test('a tool hook never sees a call the mode denied - interception cannot bypass the approval gate', async () => {
  // The security invariant. A component that could wrap a denied call would be a side channel
  // around `toolPolicy`, which is what the whole per-tool confirmation model rests on.
  const writer = makeFakeTool('write_file', 'wrote it', true);
  const loop = new AgentLoop(toolCallThenEnd('write_file'), [writer], 'system');
  let hookCalls = 0;
  loop.registerCore({
    name: 'would-intercept',
    aroundTool: async (_call, next) => {
      hookCalls++;
      return next();
    },
  });

  const results: string[] = [];
  await loop.run('write something', {
    toolPolicy: async () => 'deny',
    onEvent: (e) => {
      if (e.type === 'tool_result' && e.toolOutput) results.push(e.toolOutput);
    },
  });

  assert.equal(hookCalls, 0, 'a denied call must never reach the seam');
  assert.deepEqual(writer.calls, []);
  assert.ok(results[0]?.includes('Blocked by the current mode'), results[0]);
});

test('a tool hook IS reached for an allowed call, so the test above is not vacuous', async () => {
  const writer = makeFakeTool('write_file', 'wrote it', true);
  const loop = new AgentLoop(toolCallThenEnd('write_file'), [writer], 'system');
  let hookCalls = 0;
  loop.registerCore({
    name: 'would-intercept',
    aroundTool: async (_call, next) => {
      hookCalls++;
      return next();
    },
  });

  await loop.run('write something', { toolPolicy: async () => 'allow' });

  assert.equal(hookCalls, 1);
  assert.equal(writer.calls.length, 1);
});

test('a throwing tool hook propagates, exactly as a throwing tool already does', async () => {
  // Documented on `CoreRegistry.runTool`: there is no safe recovery, because a hook may have
  // called next() before throwing and re-running a mutating tool is a real side effect.
  const grep = makeFakeTool('grep', 'real output');
  const loop = new AgentLoop(toolCallThenEnd('grep'), [grep], 'system');
  loop.registerCore({
    name: 'explodes',
    aroundTool: async () => {
      throw new Error('graph unavailable');
    },
  });

  await assert.rejects(() => loop.run('find it'), /graph unavailable/);
});

// ---------------------------------------------------------------------------------------------
// Registry mechanics
// ---------------------------------------------------------------------------------------------

test('coreComponentNames reports registration order', () => {
  const loop = new AgentLoop(endTurn(), [], 'system');
  loop.registerCore({ name: 'alpha', onEntry: () => {} });
  loop.registerCore({ name: 'beta', buildRequest: ({ entries }) => entries });

  assert.deepEqual(loop.coreComponentNames(), ['alpha', 'beta']);
});

test('CoreRegistry reports which hooks have subscribers', () => {
  const registry = new CoreRegistry();
  assert.equal(registry.hasEntryObservers(), false);
  assert.equal(registry.hasRequestHooks(), false);
  assert.equal(registry.hasToolHooks(), false);

  registry.register({ name: 'entries-only', onEntry: () => {} });

  assert.equal(registry.hasEntryObservers(), true);
  // A component implementing one hook must not make the loop pay for the other two - these flags
  // are what lets the hot request path skip the seam entirely.
  assert.equal(registry.hasRequestHooks(), false);
  assert.equal(registry.hasToolHooks(), false);
});

test('CoreRegistry.runTool with no hooks calls execute directly', async () => {
  const registry = new CoreRegistry();
  const tool: Tool = {
    name: 'noop',
    description: 'x',
    inputSchema: {},
    execute: async () => 'direct',
  };
  let calls = 0;

  const out = await registry.runTool({ tool, input: {} }, async () => {
    calls++;
    return 'direct';
  });

  assert.equal(out, 'direct');
  assert.equal(calls, 1);
});

test('CoreRegistry.buildEntries with no hooks returns the same array identity', async () => {
  const registry = new CoreRegistry();
  const entries: readonly ContextEntry[] = [userInputEntry('hi')];

  const out = await registry.buildEntries({ entries }, () => {});

  assert.equal(out, entries, 'no hooks must mean no copying');
});
