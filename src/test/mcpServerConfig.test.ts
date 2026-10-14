import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../session/jsonMerge.js';
import {
  lifecycleOf,
  parseServers,
  reachOf,
  toolNamespace,
  type McpServerConfig,
} from '../mcp/serverConfig.js';

function only(raw: unknown): McpServerConfig {
  const { servers, problems } = parseServers(raw);
  assert.deepEqual(problems, [], 'expected no problems');
  assert.equal(servers.length, 1);
  return servers[0];
}

const STDIO = { transport: 'stdio', command: 'node', args: ['server.js'] };

test('a stdio server is spawned and a http server is attached - the transport decides, nothing else', () => {
  // The correction the Blender case forces on design doc §5.4, which borrowed pi-acp's
  // "1 session <-> 1 spawned subprocess" shape. The spec's stdio page opens with "the client
  // launches the MCP server as a subprocess", and there is no attaching to a process someone
  // else owns over stdio. So lifecycle is derived, never configured - two fields could disagree,
  // and "attach over stdio" is not a thing that exists.
  assert.equal(lifecycleOf(only({ memory: STDIO })), 'spawn');
  assert.equal(lifecycleOf(only({ blender: { transport: 'http', url: 'http://127.0.0.1:9876/mcp' } })), 'attach');
});

test('reach is about egress, not transport - a loopback application is as local as a subprocess', () => {
  // PATH_FORWARD §1a currently says stdio/local belongs in secure mode and HTTP/remote does not.
  // Blender over loopback breaks that: it has exactly as much egress as a spawned subprocess,
  // namely none, so barring it from secure mode would be wrong on §1a's own terms.
  assert.equal(reachOf(only({ memory: STDIO })), 'local');
  for (const url of [
    'http://127.0.0.1:9876/mcp',
    'http://localhost:3000/mcp',
    'http://127.1.2.3:80/mcp',
    'http://[::1]:9876/mcp',
  ]) {
    assert.equal(reachOf(only({ app: { transport: 'http', url } })), 'local', url);
  }
  for (const url of ['https://search.example.com/mcp', 'http://192.168.0.128:8080/mcp', 'http://10.0.0.11/mcp']) {
    assert.equal(reachOf(only({ app: { transport: 'http', url } })), 'remote', url);
  }
});

test('a host that merely looks loopback is remote', () => {
  // The reason the /8 check is numeric rather than a string prefix: this hostname starts with
  // "127." and resolves to wherever its owner points it.
  assert.equal(reachOf(only({ app: { transport: 'http', url: 'http://127.0.0.1.example.com/mcp' } })), 'remote');
  assert.equal(reachOf(only({ app: { transport: 'http', url: 'http://localhost.example.com/mcp' } })), 'remote');
});

test('every grant defaults to false - a server gets only what it was explicitly given', () => {
  const server = only({ memory: STDIO });
  assert.deepEqual(server.grants, { slashCommands: false, resources: false, trustReadOnlyHints: false });
  assert.equal(server.enabled, true, 'a server with no "enabled" key is on');
});

test('trustReadOnlyHints is off unless the user sets it, and a misspelled grant never reads as granted', () => {
  // The load-bearing one. MCP's spec says ToolAnnotations "should not be relied upon for security
  // decisions ... received from untrusted servers", and classifyToolAccess opens with
  // `if (!tool.mutating) return 'allow'` - unconditional, in every mode, Plan included. A server
  // that could get its readOnlyHint believed by default could execute freely in the mode whose
  // whole purpose is being read-only.
  assert.equal(only({ memory: STDIO }).grants.trustReadOnlyHints, false);
  assert.equal(only({ memory: { ...STDIO, grants: { trustReadOnlyHints: true } } }).grants.trustReadOnlyHints, true);

  const { servers, problems } = parseServers({ memory: { ...STDIO, grants: { trustReadonlyHints: true } } });
  assert.equal(servers[0].grants.trustReadOnlyHints, false, 'a typo must not silently grant trust');
  assert.ok(
    problems.some((p) => p.includes('unknown grant') && p.includes('trustReadonlyHints')),
    `expected the typo to be reported, got ${JSON.stringify(problems)}`,
  );
});

test('a non-boolean grant is false and reported, rather than truthy', () => {
  // `{ trustReadOnlyHints: "false" }` is a truthy string. Read naively that is the exact inversion
  // of what the user wrote.
  const { servers, problems } = parseServers({ memory: { ...STDIO, grants: { trustReadOnlyHints: 'false' } } });
  assert.equal(servers[0].grants.trustReadOnlyHints, false);
  assert.ok(problems.some((p) => p.includes('must be true or false')), JSON.stringify(problems));
});

test('an unreadable "enabled" disables the server instead of defaulting it on', () => {
  // An unparseable setting is not consent to run something.
  const { servers, problems } = parseServers({ memory: { ...STDIO, enabled: 'yes' } });
  assert.deepEqual(servers, []);
  assert.ok(problems.some((p) => p.includes('"enabled" must be true or false')), JSON.stringify(problems));
});

test('a disabled server still parses, so the UI can list it as off rather than lose it', () => {
  const server = only({ memory: { ...STDIO, enabled: false } });
  assert.equal(server.enabled, false);
});

test('one bad entry never costs the good ones', () => {
  // A typo in one definition must not stop o4c starting or using the other servers - the same
  // degrade-rather-than-die rule the dead-local-server path already follows.
  const { servers, problems } = parseServers({
    good: STDIO,
    broken: { transport: 'stdio' },
    alsogood: { transport: 'http', url: 'http://127.0.0.1:1/mcp' },
  });
  assert.deepEqual(
    servers.map((s) => s.id),
    ['good', 'alsogood'],
  );
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('needs a "command"'), problems[0]);
});

test('ids are restricted, because one becomes a tool name and a directory name', () => {
  for (const id of ['Memory', 'my server', 'mem__ory', '-leading', 'tool/../etc']) {
    const { servers, problems } = parseServers({ [id]: STDIO });
    assert.deepEqual(servers, [], `"${id}" must be rejected`);
    assert.equal(problems.length, 1, `"${id}": ${JSON.stringify(problems)}`);
  }
  for (const id of ['memory', 'blender', 'o4c-os', 'search_2']) {
    assert.equal(only({ [id]: STDIO }).id, id);
  }
});

test('the tool namespace keeps third-party names away from the built-in special cases', () => {
  // classifyToolAccess auto-approves `tool.name === 'write_file'` in Accept Edits mode. A
  // third-party server exposing a tool by that name must not inherit it.
  assert.equal(toolNamespace('blender') + 'write_file', 'mcp__blender__write_file');
  assert.notEqual(toolNamespace('blender') + 'write_file', 'write_file');
});

test('a url must be a Streamable HTTP endpoint, not any URL-shaped string', () => {
  for (const url of ['not a url', 'ws://127.0.0.1/mcp', 'file:///tmp/x', 'stdio://x']) {
    const { servers, problems } = parseServers({ app: { transport: 'http', url } });
    assert.deepEqual(servers, [], url);
    assert.equal(problems.length, 1, `${url}: ${JSON.stringify(problems)}`);
  }
});

test('a missing transport is rejected rather than guessed', () => {
  const { servers, problems } = parseServers({ app: { command: 'node' } });
  assert.deepEqual(servers, []);
  assert.ok(problems[0].includes('"transport" must be'), problems[0]);
});

test('no config at all is zero servers and zero complaints', () => {
  assert.deepEqual(parseServers(undefined), { servers: [], problems: [] });
  assert.deepEqual(parseServers({}), { servers: [], problems: [] });
});

test('a servers value of the wrong type is one clear problem, not a crash', () => {
  for (const raw of [[], 'memory', 42, null]) {
    const { servers, problems } = parseServers(raw);
    assert.deepEqual(servers, []);
    assert.equal(problems.length, 1, JSON.stringify(raw));
  }
});

test('stdio env and args survive; a non-string env value is dropped and reported', () => {
  const server = only({ memory: { ...STDIO, env: { TOKEN: 'abc' }, cwd: '/tmp' } });
  assert.deepEqual(server.args, ['server.js']);
  assert.deepEqual(server.env, { TOKEN: 'abc' });
  assert.equal(server.cwd, '/tmp');

  const { servers, problems } = parseServers({ memory: { ...STDIO, env: { TOKEN: 1 } } });
  assert.deepEqual(servers[0].env, {});
  assert.ok(problems.some((p) => p.includes('env.TOKEN')), JSON.stringify(problems));
});

test('the 3-tier merge lets a project override one field without restating the server', () => {
  // Not testing deepMerge itself (jsonMerge is its own unit) - testing that the entry shape
  // chosen here actually composes with the merge ConfigStore already performs, which is the whole
  // reason servers live under a key in the ['mcp'] namespace instead of a new servers.json with a
  // parallel loader.
  const global = { servers: { blender: { transport: 'http', url: 'http://127.0.0.1:9876/mcp' }, memory: STDIO } };
  const local = { servers: { blender: { url: 'http://127.0.0.1:7777/mcp' } } };
  const merged = deepMerge(global, local) as { servers: unknown };

  const { servers, problems } = parseServers(merged.servers);
  assert.deepEqual(problems, []);
  const blender = servers.find((s) => s.id === 'blender');
  assert.equal(blender?.url, 'http://127.0.0.1:7777/mcp', 'the local url wins');
  assert.equal(blender?.transport, 'http', 'and the global transport survives, unrestated');
  assert.ok(servers.some((s) => s.id === 'memory'), 'a global server the project never mentions is still there');
});

test('a project can turn a globally-defined server off, and arrays replace wholesale', () => {
  const merged = deepMerge(
    { servers: { memory: { ...STDIO, args: ['a', 'b', 'c'] } } },
    { servers: { memory: { enabled: false, args: ['only'] } } },
  ) as { servers: unknown };
  const server = only(merged.servers);
  assert.equal(server.enabled, false);
  assert.deepEqual(server.args, ['only'], 'args replace rather than concatenate');
});
