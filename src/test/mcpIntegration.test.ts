import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseServers, type McpServerConfig } from '../mcp/serverConfig.js';
import { McpHost } from '../mcp/host.js';
import { connectServer } from '../mcp/client.js';
import { classifyToolAccess } from '../ui/modePolicy.js';
import { formatConfirmMessage } from '../ui/confirmPreview.js';
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { startMcpSession } from '../mcp/startup.js';
import { buildPromptCommands, flattenPromptMessages } from '../mcp/promptCommands.js';
import { KNOWN_COMMANDS, parsePromptArguments } from '../ui/slashCommand.js';
import { FakeProvider } from './fakeProvider.js';

/**
 * End-to-end against a REAL MCP server over the real stdio transport - the SDK handshake,
 * `tools/list` and `tools/call` included. `mcpHost.test.ts` proves our own branching with fakes;
 * this proves we are driving the SDK correctly, which a fake cannot.
 *
 * The server is `fixtures/mcpFixtureServer.mjs`, built on the SDK's own server half, so this
 * depends on nothing outside `node_modules` - no cloned repo to install or build first.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcpFixtureServer.mjs');

function fixtureServer(
  mode: string,
  grants: Record<string, boolean> = {},
  env: Record<string, string> = {},
): McpServerConfig {
  const { servers, problems } = parseServers({
    fixture: {
      transport: 'stdio',
      command: process.execPath, // this exact node, not whatever "node" resolves to on PATH
      args: [FIXTURE],
      env: { O4C_FIXTURE_MODE: mode, ...env },
      grants,
    },
  });
  assert.deepEqual(problems, []);
  return servers[0];
}

test('a real server is spawned, its tools are listed, and a call round-trips', async () => {
  const host = await McpHost.start([fixtureServer('ok')]);
  try {
    assert.deepEqual(host.status()[0].state, 'ready', JSON.stringify(host.status()));
    assert.deepEqual(
      host.tools().map((t) => t.name).sort(),
      ['mcp__fixture__echo', 'mcp__fixture__write_file'],
    );

    const echo = host.tools().find((t) => t.name === 'mcp__fixture__echo');
    assert.equal(await echo?.execute({ text: 'hello' }), 'echo: hello');

    // The schema the model is shown is the server's own, carried through untouched.
    assert.deepEqual(echo?.inputSchema, {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  } finally {
    await host.shutdown();
  }
});

test('a real server claiming readOnlyHint is still denied by Plan mode', async () => {
  // The headline safety rule, proved against a server that actually sends the annotation over the
  // wire rather than a hand-built descriptor. The fixture's `write_file` declares
  // `readOnlyHint: true` and is named to collide with a built-in: it must get neither the trust
  // nor the built-in's Accept Edits exemption.
  const host = await McpHost.start([fixtureServer('ok')]);
  try {
    const tool = host.tools().find((t) => t.name === 'mcp__fixture__write_file');
    assert.ok(tool, 'the colliding tool must be registered under its namespaced name');
    assert.equal(tool.mutating, true);
    assert.equal(classifyToolAccess('plan', tool), 'deny');
    assert.equal(classifyToolAccess('manual', tool), 'confirm');
    assert.equal(classifyToolAccess('acceptEdits', tool, { path: 'x' }), 'confirm');
  } finally {
    await host.shutdown();
  }
});

test('granting trustReadOnlyHints to that same real server changes the verdict', async () => {
  // The other half: the hint is not ignored, it is the SERVER's word that is ignored. Once the
  // user vouches for this server, Plan mode allows the tool it marked read-only.
  const host = await McpHost.start([fixtureServer('ok', { trustReadOnlyHints: true })]);
  try {
    const tool = host.tools().find((t) => t.name === 'mcp__fixture__write_file');
    assert.equal(tool?.mutating, false);
    assert.equal(classifyToolAccess('plan', tool!), 'allow');

    const echo = host.tools().find((t) => t.name === 'mcp__fixture__echo');
    assert.equal(echo?.mutating, true, 'a tool with no hint is still mutating on a trusted server');
  } finally {
    await host.shutdown();
  }
});

test("a server's stderr is captured, never printed", async () => {
  // StdioClientTransport defaults to stderr:"inherit", which would write the fixture's two
  // startup lines straight into o4c's own stderr - i.e. into the middle of a rendered Ink frame.
  // This asserts we piped it instead: the text is available for diagnostics and reached nothing
  // else. (If this ever regresses, the lines appear in the test runner's own output too.)
  const host = await McpHost.start([fixtureServer('stderr')]);
  try {
    assert.equal(host.status()[0].state, 'ready', 'a chatty server is still a working server');
    const captured = host.stderrTail('fixture');
    assert.ok(captured.includes('a chatty warning on startup'), JSON.stringify(captured));
    assert.ok(captured.includes('and a second line'), JSON.stringify(captured));
  } finally {
    await host.shutdown();
  }
});

test('a server that exits before the handshake fails with its own last words', async () => {
  const host = await McpHost.start([fixtureServer('crash')]);
  assert.equal(host.status()[0].state, 'failed');
  // The stderr tail is appended to the error because "connection closed" alone never says why,
  // and the child's final line usually does.
  assert.ok(host.status()[0].detail?.includes('missing API key'), host.status()[0].detail);
  assert.deepEqual(host.tools(), []);
  await host.shutdown();
});

test('a real server that throws on every call still leaves the session usable', async () => {
  const host = await McpHost.start([fixtureServer('callfail')]);
  try {
    assert.equal(host.status()[0].state, 'ready', 'it lists tools fine; only calls fail');
    const output = await host.tools()[0].execute({ text: 'x' });
    assert.ok(output.includes('fixture'), output);
    assert.ok(output.toLowerCase().includes('fail') || output.includes('error'), output);
  } finally {
    await host.shutdown();
  }
});

test('a real server speaking the legacy toolResult shape is understood', async () => {
  // Proving the union the typechecker found is not hypothetical: this returns { toolResult } with
  // no content array at all, over the wire.
  const host = await McpHost.start([fixtureServer('legacy')]);
  try {
    assert.equal(await host.tools()[0].execute({ text: 'x' }), 'legacy shape');
  } finally {
    await host.shutdown();
  }
});

test('connectServer gives up on a server that never answers, and reaps it', { timeout: 40_000 }, async () => {
  // The silent fixture holds its process open and replies to nothing, so only the connect timeout
  // ends this. Called directly rather than through the host so the rejection itself is visible.
  const started = Date.now();
  await assert.rejects(() => connectServer(fixtureServer('silent')));
  const elapsed = Date.now() - started;
  // MCP_CONNECT_TIMEOUT_MS is 10s; the bound here only checks that *a* timeout fired rather than
  // the SDK's 60s default being used on the startup path.
  assert.ok(elapsed < 30_000, `expected the connect timeout to fire, waited ${elapsed}ms`);
});

test('a dead server does not stop a healthy one spawned beside it', async () => {
  const { servers, problems } = parseServers({
    good: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { O4C_FIXTURE_MODE: 'ok' } },
    dead: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { O4C_FIXTURE_MODE: 'crash' } },
  });
  assert.deepEqual(problems, []);

  const host = await McpHost.start(servers);
  try {
    assert.deepEqual(
      host.tools().map((t) => t.name).sort(),
      ['mcp__good__echo', 'mcp__good__write_file'],
    );
    assert.equal(host.status().find((s) => s.id === 'dead')?.state, 'failed');
    assert.equal(host.status().find((s) => s.id === 'good')?.state, 'ready');
  } finally {
    await host.shutdown();
  }
});

// ---------------------------------------------------------------------------
// The whole path, start to finish: config -> spawn -> handshake -> proxy -> loop -> turn.
// ---------------------------------------------------------------------------

test('a configured server ends up as a tool the model is offered and can run', async () => {
  // Everything cli.ts does, minus the terminal: `startMcpSession` with the config loader stubbed
  // (the only seam - the host, the spawn and the SDK are all real), appending into a real
  // AgentLoop, with a scripted provider standing in for the model.
  const loop = new AgentLoop(
    new FakeProvider([
      { content: 'asking the server', toolCalls: [{ id: 't1', name: 'mcp__fixture__echo', input: { text: 'hello' } }], stopReason: 'tool_use' },
      { content: 'it said hello', toolCalls: [], stopReason: 'end_turn' },
    ]),
    [],
    'system',
  );
  const mcp = startMcpSession({
    projectRoot: undefined,
    addTools: (tools) => loop.addTools(tools),
    load: async () => ({ servers: [fixtureServer('ok')], problems: [] }),
  });
  loop.registerPendingTools(mcp.ready);

  try {
    const events: AgentEvent[] = [];
    assert.equal(await loop.run('say hello to the server', { onEvent: (e) => events.push(e) }), 'it said hello');

    const result = events.find((e) => e.type === 'tool_result');
    assert.equal(result?.toolOutput, 'echo: hello', JSON.stringify(events.map((e) => e.type)));
    assert.deepEqual(events.filter((e) => e.type === 'warning'), [], 'a working server says nothing');
  } finally {
    await mcp.shutdown();
  }
});

test('the server o4c spawned is really gone after shutdown, not just closed', async () => {
  // `close()` resolving is not the claim worth making - the claim is that no process is left
  // behind, because o4c reloads itself into a fresh process after most turns and anything leaked
  // here is leaked once per turn for the life of the session.
  const pidFile = join(await mkdtemp(join(tmpdir(), 'o4c-mcp-pid-')), 'pid');
  const host = await McpHost.start([fixtureServer('ok', {}, { O4C_FIXTURE_PIDFILE: pidFile })]);
  assert.equal(host.status()[0].state, 'ready');

  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(pid > 0, `the fixture must have recorded its pid, got ${pid}`);
  assert.doesNotThrow(() => process.kill(pid, 0), 'it is running while the host holds it');

  await host.shutdown();
  await assert.rejects(
    async () => process.kill(pid, 0),
    /ESRCH/,
    'the subprocess must be gone once shutdown returns',
  );
});

test('killAllNow reaps a real subprocess synchronously, for the exit backstop', async () => {
  // `process.on('exit')` permits no asynchronous work at all, so this is the only cleanup the
  // restart paths' own `process.exit()` calls can reach.
  const pidFile = join(await mkdtemp(join(tmpdir(), 'o4c-mcp-kill-')), 'pid');
  const host = await McpHost.start([fixtureServer('ok', {}, { O4C_FIXTURE_PIDFILE: pidFile })]);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(pid, 0));

  host.killAllNow();
  // SIGKILL is delivered synchronously but the process table entry clears a moment later, so this
  // polls rather than asserting instantly - bounded, and it fails by timing out if it never dies.
  const deadline = Date.now() + 5_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'killAllNow must actually terminate the child');
  await host.shutdown();
});

// ---------------------------------------------------------------------------
// Approval, against a real server (checklist 21d).
// ---------------------------------------------------------------------------

test("a real server's annotations reach the confirm dialog, labelled as its own claim", async () => {
  // The fixture's `write_file` sends `readOnlyHint: true` over the wire while being, by its name,
  // the most alarming thing it could claim that about. Untrusted, so the hint changes no verdict -
  // and the user is shown both facts: who is asking, and what they say about themselves.
  const host = await McpHost.start([fixtureServer('ok')]);
  try {
    const tool = host.tools().find((t) => t.name === 'mcp__fixture__write_file');
    assert.ok(tool);
    assert.equal(classifyToolAccess('manual', tool), 'confirm', 'still asks');

    const message = formatConfirmMessage(tool.name, { path: 'x' }, { cols: 100, rows: 40 }, tool.mcp);
    const lines = message.split('\n');
    assert.ok(lines[0].startsWith('Allow mcp__fixture__write_file('), lines[0]);
    assert.ok(message.includes('"fixture"'), message);
    assert.ok(message.includes('on this machine'), message);
    assert.ok(message.includes("Server's claim, unverified: read-only"), message);
  } finally {
    await host.shutdown();
  }
});

test('granting autoApprove to a real server stops it asking - and Plan still refuses it', async () => {
  // The two halves of per-server trust, against a spawned server rather than a descriptor: the
  // grant removes the prompt in the modes that ask, and cannot touch the mode that refuses.
  const host = await McpHost.start([fixtureServer('ok', { autoApprove: true })]);
  try {
    const tool = host.tools().find((t) => t.name === 'mcp__fixture__write_file');
    assert.ok(tool);
    assert.equal(tool.mutating, true, 'the grant is about asking, not about what the tool does');
    assert.equal(classifyToolAccess('manual', tool), 'allow');
    assert.equal(classifyToolAccess('acceptEdits', tool, { path: 'x' }), 'allow');
    assert.equal(classifyToolAccess('plan', tool), 'deny');
    assert.equal(classifyToolAccess('planWrite', tool, { path: 'x' }, 'x'), 'deny');

    // And it still runs when allowed - a grant that silently broke the call would be worse than
    // no grant.
    const echo = host.tools().find((t) => t.name === 'mcp__fixture__echo');
    assert.equal(await echo?.execute({ text: 'hi' }), 'echo: hi');
  } finally {
    await host.shutdown();
  }
});

test('a turn runs an auto-approved mutating MCP tool with no policy prompt at all', async () => {
  // Through the loop, with a tool policy that fails loudly if it is ever consulted for a
  // confirmation - the behaviour the grant exists to produce, rather than just the verdict that
  // should produce it.
  const loop = new AgentLoop(
    new FakeProvider([
      { content: 'writing', toolCalls: [{ id: 't1', name: 'mcp__fixture__echo', input: { text: 'go' } }], stopReason: 'tool_use' },
      { content: 'done', toolCalls: [], stopReason: 'end_turn' },
    ]),
    [],
    'system',
  );
  const mcp = startMcpSession({
    projectRoot: undefined,
    addTools: (tools) => loop.addTools(tools),
    load: async () => ({ servers: [fixtureServer('ok', { autoApprove: true })], problems: [] }),
  });
  loop.registerPendingTools(mcp.ready);

  try {
    const consulted: string[] = [];
    const answer = await loop.run('go', {
      toolPolicy: async (tool, input) => {
        consulted.push(tool.name);
        const access = classifyToolAccess('manual', tool, input);
        assert.notEqual(access, 'confirm', `manual mode asked about ${tool.name} despite autoApprove`);
        return access === 'allow' ? 'allow' : 'deny';
      },
    });
    assert.equal(answer, 'done');
    assert.deepEqual(consulted, ['mcp__fixture__echo'], 'the policy did run - it just had nothing to ask');
  } finally {
    await mcp.shutdown();
  }
});

test('a real server offering prompts adds no commands until it is granted slashCommands', async () => {
  // The fixture declares the `prompts` capability unconditionally, so this is the default-off
  // claim against a server that genuinely has prompts to give - not against one that has none.
  const host = await McpHost.start([fixtureServer('ok')]);
  try {
    assert.equal(host.status()[0].state, 'ready');
    assert.equal(host.tools().length, 2, 'tools are unaffected either way');
    assert.deepEqual(host.promptSources(), [], 'o4c did not even ask');
    assert.deepEqual(host.promptProblems(), []);
  } finally {
    await host.shutdown();
  }
});

test('granting slashCommands turns a real server\'s prompts into real commands', async () => {
  const host = await McpHost.start([fixtureServer('ok', { slashCommands: true })]);
  try {
    const { commands, problems } = buildPromptCommands(host.promptSources(), KNOWN_COMMANDS);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      commands.map((c) => c.name).sort(),
      ['/mcp-fixture-mixed', '/mcp-fixture-review-file', '/mcp-fixture-summarize'],
    );

    // "Review File" is not typable as a command, so the row is slugged while the wire name is
    // kept - and this proves the wire name is what the real server is actually asked for.
    const review = commands.find((c) => c.name === '/mcp-fixture-review-file');
    assert.equal(review?.mcpPrompt?.promptName, 'Review File');
    assert.equal(review?.select, 'prefill', 'it takes a required argument');

    const parsed = parsePromptArguments(review!.mcpPrompt!, ' src/ui/App.tsx');
    assert.ok(parsed.ok);
    const expanded = flattenPromptMessages(
      await host.getPrompt('fixture', review!.mcpPrompt!.promptName, parsed.args),
    );
    assert.equal(expanded.text, 'Please review src/ui/App.tsx line by line.');
    assert.deepEqual(expanded.notes, []);

    // The no-argument one runs straight away and needs no tail.
    const summarize = commands.find((c) => c.name === '/mcp-fixture-summarize');
    assert.equal(summarize?.select, 'run');
    const summary = flattenPromptMessages(await host.getPrompt('fixture', 'summarize', {}));
    assert.equal(summary.text, 'Summarize the work so far.');
  } finally {
    await host.shutdown();
  }
});

test('a real prompt carrying an assistant turn and an image is reported, not silently halved', async () => {
  const host = await McpHost.start([fixtureServer('ok', { slashCommands: true })]);
  try {
    const flat = flattenPromptMessages(await host.getPrompt('fixture', 'mixed', {}));
    assert.match(flat.text, /first, the user half/);
    assert.match(flat.text, /\[assistant, from the prompt template\]/);
    assert.equal(flat.notes.length, 2, JSON.stringify(flat.notes));
    assert.ok(flat.notes.some((n) => /1 assistant turn/.test(n)));
    assert.ok(flat.notes.some((n) => /1 image part/.test(n)));
  } finally {
    await host.shutdown();
  }
});

test('a real server whose prompts/list throws keeps its tools, and the session says why', async () => {
  const session = startMcpSession({
    projectRoot: undefined,
    addTools: () => {},
    load: async () => ({ servers: [fixtureServer('promptfail', { slashCommands: true })], problems: [] }),
  });
  try {
    const notices = await session.ready;
    assert.deepEqual(session.status().map((s) => s.state), ['ready'], 'the server itself is fine');
    assert.deepEqual(session.promptCommands(), []);
    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.match(notices[0], /granted slashCommands but its prompts could not be listed/);
    assert.match(notices[0], /its tools are unaffected/);
    assert.match(notices[0], /prompts are broken here/);
  } finally {
    await session.shutdown();
  }
});

test('the whole prompt path works through a session: config to command to expanded text', async () => {
  const session = startMcpSession({
    projectRoot: undefined,
    addTools: () => {},
    load: async () => ({ servers: [fixtureServer('ok', { slashCommands: true })], problems: [] }),
  });
  try {
    assert.deepEqual(await session.ready, [], 'a working setup is silent');
    const review = session.promptCommands().find((c) => c.name === '/mcp-fixture-review-file');
    assert.ok(review?.mcpPrompt);
    const expanded = await session.expandPrompt(review.mcpPrompt, { path: 'a.ts' });
    assert.equal(expanded.text, 'Please review a.ts line by line.');

    // And the listing /mcp prints describes what just happened.
    const report = session.statusReport();
    assert.equal(report[0], 'MCP servers:');
    assert.equal(report[1], '  fixture - 2 tools, spawned, local');
    assert.ok(report.includes('Prompt commands:'));
    assert.ok(report.some((l) => l.startsWith('  /mcp-fixture-review-file - Review one file')));
  } finally {
    await session.shutdown();
  }
});
