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
import { AgentLoop, type AgentEvent } from '../agent/loop.js';
import { startMcpSession } from '../mcp/startup.js';
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
