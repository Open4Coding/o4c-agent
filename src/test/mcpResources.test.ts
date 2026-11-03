import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseServers, toolAllowed } from '../mcp/serverConfig.js';
import { McpHost } from '../mcp/host.js';
import { describePresets, MCP_PRESETS, resourceMentions } from '../mcp/presets.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcpFixtureServer.mjs');

test('toolAllowed: allow list, deny list, wildcards, deny wins', () => {
  assert.equal(toolAllowed(undefined, 'anything'), true);
  assert.equal(toolAllowed({ allow: ['read_*'] }, 'read_file'), true);
  assert.equal(toolAllowed({ allow: ['read_*'] }, 'write_file'), false);
  assert.equal(toolAllowed({ deny: ['delete*'] }, 'delete_repo'), false);
  assert.equal(toolAllowed({ allow: ['*'], deny: ['echo'] }, 'echo'), false);
  assert.equal(toolAllowed({ allow: ['a.b'] }, 'axb'), false, 'dots are literal, not regex');
});

test('resourceMentions finds @server:ref only for known servers', () => {
  assert.deepEqual(resourceMentions('see @docs:docs://readme and @nope:x and mail@docs:y', new Set(['docs'])), [{ token: '@docs:docs://readme', serverId: 'docs', ref: 'docs://readme' }]);
});

test('presets build valid server entries', () => {
  for (const p of MCP_PRESETS) {
    const { problems } = parseServers({ [p.name]: p.entry('/work/repo') });
    assert.deepEqual(problems, [], p.name);
  }
  assert.match(describePresets().join('\n'), /filesystem .*Read and write files/);
});

test('a real server: resources listed and read by URI or name, the tool filter applied, /mcp inspect shows it all', async () => {
  const { servers, problems } = parseServers({
    fixture: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { O4C_FIXTURE_MODE: 'resources' }, tools: { deny: ['write_*'] } },
  });
  assert.deepEqual(problems, []);
  const host = await McpHost.start(servers);
  try {
    assert.deepEqual(host.resources().map((r) => r.uri).sort(), ['docs://changelog', 'docs://readme']);
    assert.equal(await host.readResource('fixture', 'docs://readme'), 'Read me first.');
    assert.equal(await host.readResource('fixture', 'changelog'), 'v1: first release.');
    assert.deepEqual(host.tools().map((t) => t.name), ['mcp__fixture__echo'], 'write_file filtered out');
    const text = host.inspect('fixture').join('\n');
    assert.match(text, /MCP server "fixture": ready/);
    assert.match(text, /capabilities: .*resources/);
    assert.match(text, /tools \(2, 1 offered after the tools filter\)/);
    assert.match(text, /x write_file/);
    assert.match(text, /resources \(2\) - attach one with @fixture:<uri or name>/);
    assert.match(host.inspect('nope').join('\n'), /No MCP server "nope"/);
  } finally {
    await host.shutdown();
  }
});
