import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServers, type McpServerConfig } from '../mcp/serverConfig.js';
import { McpHost } from '../mcp/host.js';
import type { ConnectedServer } from '../mcp/client.js';
import type { McpToolDescriptor } from '../mcp/toolProxy.js';
import type { McpPromptDescriptor, McpPromptResult } from '../mcp/promptCommands.js';

function configure(raw: Record<string, unknown>): readonly McpServerConfig[] {
  const { servers, problems } = parseServers(raw);
  assert.deepEqual(problems, [], 'fixture config must be valid');
  return servers;
}

const STDIO = { transport: 'stdio', command: 'node', args: ['s.js'] };

/** A connected server that answers from a fixture, with no subprocess anywhere. */
function fakeConnection(
  config: McpServerConfig,
  tools: McpToolDescriptor[],
  opts: {
    onCall?: () => Promise<{ content?: unknown }>;
    closed?: string[];
    killed?: string[];
    prompts?: McpPromptDescriptor[];
    promptProblem?: string;
    onPrompt?: (name: string, args: Record<string, string>) => Promise<McpPromptResult>;
  } = {},
): ConnectedServer {
  return {
    config,
    tools,
    prompts: opts.prompts ?? [],
    promptProblem: opts.promptProblem,
    callTool: opts.onCall ?? (async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    getPrompt:
      opts.onPrompt ??
      (async (name) => ({ messages: [{ role: 'user' as const, content: { type: 'text', text: `expanded ${name}` } }] })),
    stderrTail: () => '',
    close: async () => {
      opts.closed?.push(config.id);
    },
    killNow: () => {
      opts.killed?.push(config.id);
    },
  };
}

const ONE_TOOL: McpToolDescriptor[] = [{ name: 'render', inputSchema: { type: 'object' } }];

test('a ready server contributes namespaced tools and reports itself ready', async () => {
  const servers = configure({ blender: STDIO });
  const host = await McpHost.start(servers, { connect: async (s) => fakeConnection(s, ONE_TOOL) });

  assert.deepEqual(
    host.tools().map((t) => t.name),
    ['mcp__blender__render'],
  );
  assert.deepEqual(host.status(), [
    { id: 'blender', state: 'ready', lifecycle: 'spawn', reach: 'local', toolCount: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// The three failure paths. These are the reason this class exists at all.
// ---------------------------------------------------------------------------

test('a server that never starts costs only its own tools', async () => {
  const servers = configure({ broken: STDIO, working: { ...STDIO, command: 'node2' } });
  const host = await McpHost.start(servers, {
    connect: async (s) => {
      if (s.id === 'broken') throw new Error('spawn ENOENT');
      return fakeConnection(s, ONE_TOOL);
    },
  });

  assert.deepEqual(
    host.tools().map((t) => t.name),
    ['mcp__working__render'],
    'the healthy server is unaffected',
  );
  const broken = host.status().find((s) => s.id === 'broken');
  assert.equal(broken?.state, 'failed');
  assert.ok(broken?.detail?.includes('spawn ENOENT'), broken?.detail);
  assert.equal(broken?.toolCount, 0);
});

test('a server that dies mid-session leaves the session usable', async () => {
  // It connected, so its tools are registered. The failure happens on the call, and has to arrive
  // as a tool result the model can read - not as a thrown error that ends the turn.
  const servers = configure({ blender: STDIO });
  const host = await McpHost.start(servers, {
    connect: async (s) =>
      fakeConnection(s, ONE_TOOL, {
        onCall: async () => {
          throw new Error('MCP error -32000: Connection closed');
        },
      }),
  });

  const [tool] = host.tools();
  const output = await tool.execute({});
  assert.ok(output.includes('Connection closed'), output);
  assert.ok(output.includes('blender'), 'and it says which server died');
});

test('a server returning nonsense produces a readable result rather than a crash', async () => {
  const servers = configure({ blender: STDIO });
  const host = await McpHost.start(servers, {
    connect: async (s) => fakeConnection(s, ONE_TOOL, { onCall: async () => ({ content: 'not an array' }) }),
  });
  assert.equal(await host.tools()[0].execute({}), '[the tool returned no content]');
});

test('every server failing is an empty tool list, not an exception', async () => {
  const servers = configure({ a: STDIO, b: STDIO });
  const host = await McpHost.start(servers, {
    connect: async () => {
      throw new Error('nope');
    },
  });
  assert.deepEqual(host.tools(), []);
  assert.deepEqual(
    host.status().map((s) => s.state),
    ['failed', 'failed'],
  );
});

// ---------------------------------------------------------------------------
// Gating.
// ---------------------------------------------------------------------------

test('a disabled server is never connected, and is still listed so it can be seen', async () => {
  const servers = configure({ off: { ...STDIO, enabled: false } });
  let connects = 0;
  const host = await McpHost.start(servers, {
    connect: async (s) => {
      connects++;
      return fakeConnection(s, ONE_TOOL);
    },
  });
  assert.equal(connects, 0, 'a disabled server must not be spawned');
  assert.deepEqual(host.tools(), []);
  assert.equal(host.status()[0].state, 'disabled');
});

test('secure mode blocks a remote server but allows a loopback one', async () => {
  // The egress-not-transport rule. A loopback application has exactly as much egress as a spawned
  // subprocess, namely none, so secure mode has no reason to refuse it - which is the correction
  // the Blender case forces on PATH_FORWARD §1a's stdio-versus-HTTP shorthand.
  const servers = configure({
    plugin: STDIO,
    blender: { transport: 'http', url: 'http://127.0.0.1:9876/mcp' },
    search: { transport: 'http', url: 'https://search.example.com/mcp' },
  });
  const attempted: string[] = [];
  const host = await McpHost.start(servers, {
    secureMode: true,
    connect: async (s) => {
      attempted.push(s.id);
      return fakeConnection(s, ONE_TOOL);
    },
  });

  assert.deepEqual(attempted.sort(), ['blender', 'plugin'], 'the remote server is never even contacted');
  const search = host.status().find((s) => s.id === 'search');
  assert.equal(search?.state, 'blocked');
  assert.equal(search?.reach, 'remote');
  assert.ok(search?.detail?.includes('secure mode') || search?.detail?.includes('Secure mode'), search?.detail);
});

test('secure mode allows a LAN server, and its reach still reads "remote"', async () => {
  // Added with 21f. The gate moved from "does this leave the machine" to "does this leave the
  // network", because this project's own model server lives on the LAN (PATH_FORWARD §10) and a
  // mode that refused it would be switched off rather than obeyed. The two questions stay separate
  // on purpose: `reach` still says 'remote', which is what the confirmation dialog needs in order
  // to warn that the call leaves this machine.
  const servers = configure({ lan: { transport: 'http', url: 'http://192.168.0.128:8080/mcp' } });
  const attempted: string[] = [];
  const host = await McpHost.start(servers, {
    secureMode: true,
    connect: async (s) => {
      attempted.push(s.id);
      return fakeConnection(s, ONE_TOOL);
    },
  });

  assert.deepEqual(attempted, ['lan'], 'a LAN server must be reachable in secure mode');
  assert.equal(host.status()[0].state, 'ready');
  assert.equal(host.status()[0].reach, 'remote', 'the dialog must still be told the call leaves this machine');
});

test('secure mode blocks a LAN server given by name rather than by address', async () => {
  // The documented limitation, asserted so it stays deliberate rather than becoming folklore:
  // resolving a name would mean DNS on the config-parsing path, so a bare name is treated as
  // off-site and the refusal says so.
  const servers = configure({ byname: { transport: 'http', url: 'http://phoebe:8080/mcp' } });
  const host = await McpHost.start(servers, {
    secureMode: true,
    connect: async (s) => fakeConnection(s, ONE_TOOL),
  });

  assert.equal(host.status()[0].state, 'blocked');
  assert.ok(host.status()[0].detail?.includes('IP address'), host.status()[0].detail);
});

test('without secure mode the same remote server connects', async () => {
  const servers = configure({ search: { transport: 'http', url: 'https://search.example.com/mcp' } });
  const host = await McpHost.start(servers, { connect: async (s) => fakeConnection(s, ONE_TOOL) });
  assert.equal(host.status()[0].state, 'ready');
  assert.equal(host.status()[0].lifecycle, 'attach');
  assert.equal(host.status()[0].reach, 'remote');
});

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

test('shutdown closes every connection and drops the tools', async () => {
  // This runs often, not just at exit: o4c reloads itself into a fresh process after most turns,
  // so a spawned server leaking per turn would be a process leak per turn.
  const closed: string[] = [];
  const servers = configure({ a: STDIO, b: STDIO });
  const host = await McpHost.start(servers, { connect: async (s) => fakeConnection(s, ONE_TOOL, { closed }) });
  assert.equal(host.tools().length, 2);

  await host.shutdown();
  assert.deepEqual(closed.sort(), ['a', 'b']);
  assert.deepEqual(host.tools(), []);
});

test('shutdown does not stop at the first connection that fails to close', async () => {
  const closed: string[] = [];
  const servers = configure({ bad: STDIO, good: STDIO });
  const host = await McpHost.start(servers, {
    connect: async (s) =>
      s.id === 'bad'
        ? { ...fakeConnection(s, ONE_TOOL), close: async () => { throw new Error('already gone'); } }
        : fakeConnection(s, ONE_TOOL, { closed }),
  });

  await assert.doesNotReject(() => host.shutdown());
  assert.deepEqual(closed, ['good'], 'the other connection is still closed');
});

test('no configured servers is a host with nothing in it', async () => {
  const host = await McpHost.start([], {});
  assert.deepEqual(host.tools(), []);
  assert.deepEqual(host.status(), []);
  await assert.doesNotReject(() => host.shutdown());
});

test('servers are connected concurrently, so N slow servers cost one wait, not N', async () => {
  // Startup-path behaviour worth pinning: in series this would take 5 x 60ms. The assertion has
  // generous headroom so it is checking "overlapped", not a precise duration.
  const servers = configure(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, STDIO])));
  const started = Date.now();
  const host = await McpHost.start(servers, {
    connect: async (s) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return fakeConnection(s, ONE_TOOL);
    },
  });
  const elapsed = Date.now() - started;

  assert.equal(host.tools().length, 5);
  assert.ok(elapsed < 240, `expected overlapping connects, took ${elapsed}ms for 5 x 60ms`);
});

test('promptSources carries only the servers that actually have prompts', async () => {
  const servers = configure({ withprompts: STDIO, without: STDIO });
  const host = await McpHost.start(servers, {
    connect: async (s) =>
      fakeConnection(s, ONE_TOOL, s.id === 'withprompts' ? { prompts: [{ name: 'summarize' }] } : {}),
  });
  assert.deepEqual(
    host.promptSources().map((p) => p.config.id),
    ['withprompts'],
  );
  assert.deepEqual(host.promptSources()[0].prompts.map((p) => p.name), ['summarize']);
  await host.shutdown();
});

test('a server whose prompts could not be listed keeps its tools and is reported by name', async () => {
  const servers = configure({ fixture: STDIO });
  const host = await McpHost.start(servers, {
    connect: async (s) => fakeConnection(s, ONE_TOOL, { promptProblem: 'prompts are broken here' }),
  });
  // The point: losing the prompts must not cost the tools, which is the much bigger failure.
  assert.equal(host.tools().length, 1);
  assert.equal(host.status()[0].state, 'ready');
  const problems = host.promptProblems();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MCP server "fixture" is granted slashCommands/);
  assert.match(problems[0], /its tools are unaffected/);
  assert.match(problems[0], /prompts are broken here/);
  await host.shutdown();
});

test('getPrompt reaches the right server, and says so when that server is gone', async () => {
  const servers = configure({ alpha: STDIO });
  const asked: string[] = [];
  const host = await McpHost.start(servers, {
    connect: async (s) =>
      fakeConnection(s, ONE_TOOL, {
        prompts: [{ name: 'review' }],
        onPrompt: async (name, args) => {
          asked.push(`${name}:${JSON.stringify(args)}`);
          return { messages: [{ role: 'user' as const, content: { type: 'text', text: 'ok' } }] };
        },
      }),
  });
  const result = await host.getPrompt('alpha', 'review', { path: 'a.ts' });
  assert.deepEqual(asked, ['review:{"path":"a.ts"}']);
  assert.equal(result.messages[0].content.text, 'ok');

  // Not "return nothing": the only caller resolved the id from a row this host produced, so a
  // miss means the rows outlived the connection and the user needs telling.
  await assert.rejects(() => host.getPrompt('nosuch', 'review', {}), /not connected/);
  await host.shutdown();
});
