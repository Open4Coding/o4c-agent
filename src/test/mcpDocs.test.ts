import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GRANT_KEYS, parseServers } from '../mcp/serverConfig.js';
import { SECURE_MODE_CONFIG_KEY } from '../session/secureMode.js';
import { MCP_SERVERS_KEY } from '../mcp/registry.js';

/**
 * Keeps `.docs/mcp.md` honest - checklist item 21g.
 *
 * A user-facing doc is the one artefact with no compiler and no runtime behind it, so it drifts
 * silently and is then worse than no doc: someone follows it and it does not work. These tests
 * hold it to the things the code can actually be asked.
 */

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.docs', 'mcp.md');
const doc = await readFile(DOC, 'utf8');

test('every grant the parser accepts is documented', () => {
  // The failure this prevents: a fifth grant is added to GRANT_KEYS and the doc keeps listing four,
  // so the one nobody documented is the one nobody configures correctly.
  for (const grant of GRANT_KEYS) {
    assert.ok(doc.includes(grant), `.docs/mcp.md does not mention the "${grant}" grant`);
  }
});

test('the doc names the config key the loader actually reads', () => {
  assert.ok(doc.includes(`"${MCP_SERVERS_KEY}"`), `the doc must name the "${MCP_SERVERS_KEY}" key`);
  assert.ok(doc.includes(SECURE_MODE_CONFIG_KEY), 'the doc must name the secureMode key');
});

test('the doc names all three config file paths', () => {
  for (const path of [
    '~/.o4c/mcp/config.json',
    '<project>/.o4c/mcp/config.json',
    '<project>/.o4c/mcp/config.local.json',
  ]) {
    assert.ok(doc.includes(path), `.docs/mcp.md does not mention ${path}`);
  }
});

test('the doc\'s own example config is actually valid', () => {
  // The highest-value check here by a distance: the snippet a user copies has to parse. Extracted
  // from the doc rather than duplicated, so it cannot pass against a stale copy of itself.
  const fence = doc.match(/```json\n([\s\S]*?)```/);
  assert.ok(fence, 'the doc must contain a json example');
  const parsed = JSON.parse(fence[1]) as Record<string, unknown>;
  const { servers, problems } = parseServers(parsed[MCP_SERVERS_KEY]);
  assert.deepEqual(problems, [], 'the documented example must produce no problems');
  assert.deepEqual(
    servers.map((s) => s.id).sort(),
    ['blender', 'myplugin'],
    'both documented servers must parse',
  );
  // And the example demonstrates both transports, since that is the field with no default.
  assert.deepEqual(servers.map((s) => s.transport).sort(), ['http', 'stdio']);
});

test('the doc states the tool-name namespace in the form the model sees', () => {
  assert.ok(doc.includes('mcp__'), 'the doc must show the mcp__<server>__<tool> namespace');
  assert.ok(doc.includes('/mcp-'), 'the doc must show the /mcp-<server>-<prompt> command form');
});

test('the doc does not promise the resources grant works', () => {
  // It is parsed and validated and nothing consumes it. A doc that implied otherwise would send
  // someone to debug their own server for a day.
  const lower = doc.toLowerCase();
  assert.ok(
    lower.includes('nothing consumes it') || lower.includes('not built yet'),
    'the doc must say resources is unimplemented',
  );
});

test('the doc warns that a spawned server does not inherit the shell environment', () => {
  // Found while writing the doc: the MCP SDK passes only DEFAULT_INHERITED_ENV_VARS, so an
  // exported token silently does not reach the server. The single most likely thing to waste a
  // user's afternoon, so it must stay in the doc.
  assert.ok(
    doc.includes('does not inherit your whole environment') || doc.includes('does not reach the server'),
    'the doc must warn about the env allowlist',
  );
});
