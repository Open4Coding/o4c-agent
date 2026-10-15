import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '../tools/types.js';
import { McpHost, type McpHostOptions } from '../mcp/host.js';
import { parseServers, type McpServerConfig } from '../mcp/serverConfig.js';
import type { ConnectedServer } from '../mcp/client.js';
import type { McpToolDescriptor } from '../mcp/toolProxy.js';
import type { McpPromptDescriptor } from '../mcp/promptCommands.js';
import { startMcpSession, statusReport, type McpSessionOptions } from '../mcp/startup.js';

/**
 * The startup policy: what is read, when tools arrive, what the user is told, and what happens on
 * the way out. No terminal, no provider, no subprocess - `mcpIntegration.test.ts` covers the real
 * ones. What matters here is that a broken MCP setup is a worse session and never a dead one.
 */

const STDIO = { transport: 'stdio', command: 'node', args: ['s.js'] };

function fakeConnection(
  config: McpServerConfig,
  opts: { closed?: string[]; prompts?: McpPromptDescriptor[]; promptProblem?: string } = {},
): ConnectedServer {
  const tools: McpToolDescriptor[] = [{ name: 'render', inputSchema: { type: 'object' } }];
  return {
    config,
    tools,
    prompts: opts.prompts ?? [],
    promptProblem: opts.promptProblem,
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    getPrompt: async (name) => ({
      messages: [{ role: 'user' as const, content: { type: 'text', text: `expanded ${name}` } }],
    }),
    stderrTail: () => '',
    close: async () => {
      opts.closed?.push(config.id);
    },
    killNow: () => {},
  };
}

/**
 * A session wired to fixture config and fake connections.
 *
 * The `start` seam delegates to the real `McpHost.start`, overriding only `connect` - so these
 * tests run the actual host, status and shutdown code rather than a lookalike, and still spawn
 * nothing. `starts` counts host creations, for the "nothing configured costs nothing" claim.
 */
function session(
  raw: Record<string, unknown>,
  overrides: {
    problems?: string[];
    connect?: McpHostOptions['connect'];
    secureMode?: boolean;
    projectRoot?: string;
  } = {},
) {
  const { servers, problems } = parseServers(raw);
  const added: Tool[] = [];
  const seenRoots: Array<string | undefined> = [];
  const seenSecure: Array<boolean | undefined> = [];
  let starts = 0;

  const options: McpSessionOptions = {
    projectRoot: overrides.projectRoot,
    secureMode: overrides.secureMode,
    addTools: (tools) => added.push(...tools),
    load: async (projectRoot) => {
      seenRoots.push(projectRoot);
      return { servers, problems: [...problems, ...(overrides.problems ?? [])] };
    },
    start: (configured, hostOptions) => {
      starts++;
      seenSecure.push(hostOptions?.secureMode);
      return McpHost.start(configured, {
        ...hostOptions,
        connect: overrides.connect ?? (async (s) => fakeConnection(s)),
      });
    },
  };

  return { handle: startMcpSession(options), added, seenRoots, seenSecure, starts: () => starts };
}

test('a ready server appends its tools and resolves with nothing to say', async () => {
  const s = session({ blender: STDIO });
  const notices = await s.handle.ready;

  assert.deepEqual(notices, [], 'a working setup is silent');
  assert.deepEqual(s.added.map((t) => t.name), ['mcp__blender__render']);
  assert.deepEqual(s.handle.status().map((row) => row.state), ['ready']);
});

test('nothing configured starts no host at all', async () => {
  // The common case, and it has to cost nothing: no host, no timers, no behaviour change for a
  // user who has never set up an MCP server.
  const s = session({});
  assert.deepEqual(await s.handle.ready, []);
  assert.equal(s.starts(), 0);
  assert.deepEqual(s.handle.status(), []);
  assert.deepEqual(s.added, []);
  await assert.doesNotReject(() => s.handle.shutdown());
});

test('config problems are reported even when they left no servers to start', async () => {
  // A typo that produced nothing is exactly when the user needs telling - silence here would read
  // as "MCP is fine, your tool just does not exist".
  const s = session({ 'Bad Id': STDIO });
  const notices = await s.handle.ready;
  assert.equal(s.starts(), 0, 'nothing valid was configured');
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.ok(notices[0].includes('Bad Id'), notices[0]);
});

test('a server that fails to start is named, with the reason, and costs only its own tools', async () => {
  const s = session(
    { broken: STDIO, working: STDIO },
    {
      connect: async (server) => {
        if (server.id === 'broken') throw new Error('spawn ENOENT');
        return fakeConnection(server);
      },
    },
  );
  const notices = await s.handle.ready;

  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.ok(notices[0].includes('"broken"'), notices[0]);
  assert.ok(notices[0].includes('spawn ENOENT'), notices[0]);
  assert.deepEqual(s.added.map((t) => t.name), ['mcp__working__render']);
});

test('a blocked server is reported too, a disabled one is not', async () => {
  // Being refused by secure mode is news; being switched off is the user's own setting.
  const s = session(
    {
      remote: { transport: 'http', url: 'https://search.example.com/mcp' },
      off: { ...STDIO, enabled: false },
      local: STDIO,
    },
    { secureMode: true },
  );
  const notices = await s.handle.ready;

  assert.deepEqual(s.seenSecure, [true], 'secure mode reaches the host');
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.ok(notices[0].includes('"remote"'), notices[0]);
  assert.deepEqual(
    s.handle.status().map((row) => `${row.id}:${row.state}`).sort(),
    ['local:ready', 'off:disabled', 'remote:blocked'],
  );
});

test('an untrusted project reads global config only', async () => {
  // `cli.ts` passes `trusted ? projectRoot : undefined`, and this is the half of that contract
  // this layer owns: whatever it is given is what reaches the loader, unchanged. An MCP entry in
  // an untrusted repo is not a preference, it is a command line o4c would spawn.
  const untrusted = session({ a: STDIO });
  await untrusted.handle.ready;
  assert.deepEqual(untrusted.seenRoots, [undefined]);

  const trusted = session({ a: STDIO }, { projectRoot: 'D:/some/project' });
  await trusted.handle.ready;
  assert.deepEqual(trusted.seenRoots, ['D:/some/project']);
});

test('an unforeseen throw anywhere in startup is a notice, not a dead session', async () => {
  const options: McpSessionOptions = {
    projectRoot: undefined,
    addTools: () => {},
    load: async () => {
      throw new Error('the loader itself broke');
    },
  };
  const handle = startMcpSession(options);
  const notices = await handle.ready;
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('the loader itself broke'), notices[0]);
  await assert.doesNotReject(() => handle.shutdown());
});

test('shutdown closes the servers, and says so only once', async () => {
  const closed: string[] = [];
  const s = session({ a: STDIO, b: STDIO }, { connect: async (server) => fakeConnection(server, { closed }) });
  await s.handle.ready;

  await s.handle.shutdown();
  assert.deepEqual(closed.sort(), ['a', 'b']);

  // Called again on the way out (the one-shot path's `finally`, then the exit backstop): it must
  // be harmless, not a second round of closes against connections that are already gone.
  await assert.doesNotReject(() => s.handle.shutdown());
  assert.deepEqual(closed.sort(), ['a', 'b']);
});

test('shutdown immediately after start still closes a server that was mid-connect', async () => {
  // The race worth pinning: `startMcpSession` returns before anything has connected, so a
  // shutdown arriving in that window must not leave a connection - and its subprocess - created a
  // moment after we stopped looking.
  const closed: string[] = [];
  const s = session(
    { slow: STDIO },
    {
      connect: async (server) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fakeConnection(server, { closed });
      },
    },
  );

  await s.handle.shutdown();
  assert.deepEqual(closed, ['slow']);
});

test('shutdown gives up on a server that will not close, rather than hanging', async () => {
  // Bounded on purpose: this runs on the per-turn reload path, so a wedged server must cost a
  // bounded pause and then a kill - never the turn.
  const killed: string[] = [];
  const s = session(
    { wedged: STDIO },
    {
      connect: async (server) => ({
        ...fakeConnection(server),
        close: () => new Promise<void>(() => {}), // never settles
        killNow: () => killed.push(server.id),
      }),
    },
  );
  await s.handle.ready;

  const started = Date.now();
  await s.handle.shutdown();
  const elapsed = Date.now() - started;

  assert.deepEqual(killed, ['wedged'], 'it is killed once the graceful close overruns');
  assert.ok(elapsed < 4_000, `shutdown must be bounded, took ${elapsed}ms`);
});

test('killAllNow is synchronous, and safe before anything has connected', () => {
  const s = session({ a: STDIO });
  assert.doesNotThrow(() => s.handle.killAllNow(), 'the exit backstop can fire at any moment');
});

test('a granted server\'s prompts become command rows once discovery finishes', async () => {
  const { handle: mcp } = session(
    { fixture: { ...STDIO, grants: { slashCommands: true } } },
    { connect: async (s) => fakeConnection(s, { prompts: [{ name: 'summarize', description: 'Summarize the work so far' }] }) },
  );
  // Empty before ready, which is the whole reason this arrives as a promise.
  assert.deepEqual(mcp.promptCommands(), []);
  await mcp.ready;
  assert.deepEqual(
    mcp.promptCommands().map((c) => c.name),
    ['/mcp-fixture-summarize'],
  );
  await mcp.shutdown();
});

test('a prompt that could not be listed becomes a notice, not a dead command', async () => {
  const { handle: mcp } = session(
    { fixture: { ...STDIO, grants: { slashCommands: true } } },
    { connect: async (s) => fakeConnection(s, { promptProblem: 'prompts are broken here' }) },
  );
  const notices = await mcp.ready;
  assert.deepEqual(mcp.promptCommands(), []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /granted slashCommands but its prompts could not be listed/);
  await mcp.shutdown();
});

test('expandPrompt returns flattened text, so the UI never sees an MCP shape', async () => {
  const { handle: mcp } = session(
    { fixture: { ...STDIO, grants: { slashCommands: true } } },
    { connect: async (s) => fakeConnection(s, { prompts: [{ name: 'summarize' }] }) },
  );
  await mcp.ready;
  const ref = mcp.promptCommands()[0].mcpPrompt;
  assert.ok(ref);
  const expanded = await mcp.expandPrompt(ref, {});
  assert.equal(expanded.text, 'expanded summarize');
  assert.deepEqual(expanded.notes, []);
  await mcp.shutdown();
});

test('expandPrompt rejects rather than hanging when nothing is running', async () => {
  const { handle: mcp } = session({}, {});
  await mcp.ready;
  await assert.rejects(
    () => mcp.expandPrompt({ serverId: 'fixture', promptName: 'x', arguments: [] }, {}),
    /No MCP server is running/,
  );
  await mcp.shutdown();
});

test('statusReport names every server and its state, and says when none adds commands', () => {
  const lines = statusReport(
    [
      { id: 'fixture', state: 'ready', lifecycle: 'spawn', reach: 'local', toolCount: 2 },
      { id: 'search', state: 'blocked', lifecycle: 'attach', reach: 'remote', toolCount: 0, detail: 'Secure mode.' },
      { id: 'off', state: 'disabled', lifecycle: 'spawn', reach: 'local', toolCount: 0, detail: 'Turned off in config.' },
    ],
    [],
  );
  assert.equal(lines[0], 'MCP servers:');
  assert.equal(lines[1], '  fixture - 2 tools, spawned, local');
  assert.equal(lines[2], '  search - blocked: Secure mode.');
  assert.equal(lines[3], '  off - disabled: Turned off in config.');
  // The two grants are different things, so a ready server says nothing about commands.
  assert.ok(lines.some((l) => /No server adds slash commands/.test(l)));
});

test('statusReport lists the prompt commands when there are any', () => {
  const lines = statusReport(
    [{ id: 'fixture', state: 'ready', lifecycle: 'spawn', reach: 'local', toolCount: 1 }],
    [{ name: '/mcp-fixture-summarize', description: 'Summarize the work so far' }],
  );
  assert.ok(lines.includes('Prompt commands:'));
  assert.ok(lines.includes('  /mcp-fixture-summarize - Summarize the work so far'));
  assert.equal(lines[1], '  fixture - 1 tool, spawned, local');
});

test('statusReport says where to configure servers when there are none', () => {
  const lines = statusReport([], []);
  // "No servers" is indistinguishable from "o4c cannot do MCP" unless the file is named.
  assert.deepEqual(lines, [
    'No MCP servers are configured.',
    'Add them under "servers" in .o4c/mcp/config.json.',
  ]);
});
