import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServers, type McpServerConfig } from '../mcp/serverConfig.js';
import {
  flattenToolResult,
  isMutating,
  mcpToolName,
  originalToolName,
  proxyTools,
  type McpToolDescriptor,
} from '../mcp/toolProxy.js';
import { classifyToolAccess, MODES } from '../ui/modePolicy.js';
import { defaultTools } from '../tools/index.js';

function server(grants: Record<string, boolean> = {}): McpServerConfig {
  const { servers, problems } = parseServers({ blender: { transport: 'stdio', command: 'node', grants } });
  assert.deepEqual(problems, []);
  return servers[0];
}

const DESCRIPTOR: McpToolDescriptor = {
  name: 'render',
  description: 'Render the scene',
  inputSchema: { type: 'object', properties: { frame: { type: 'number' } } },
};

test('a proxied tool is namespaced, and the namespace round-trips', () => {
  assert.equal(mcpToolName('blender', 'render'), 'mcp__blender__render');
  assert.equal(originalToolName('blender', 'mcp__blender__render'), 'render');
  // A name that was never namespaced comes back unchanged rather than mangled.
  assert.equal(originalToolName('blender', 'render'), 'render');
});

test('the input schema passes straight through - MCP and our Tool already agree', () => {
  const [tool] = proxyTools(server(), [DESCRIPTOR], async () => ({ content: [] }));
  assert.deepEqual(tool.inputSchema, DESCRIPTOR.inputSchema);
  assert.ok(tool.description.includes('blender'), 'the description names the server, not just the tool');
  assert.ok(tool.description.includes('Render the scene'));
});

test('a tool with no description still gets a usable one', () => {
  const [byTitle] = proxyTools(server(), [{ name: 'x', inputSchema: {}, annotations: { title: 'Nice Title' } }], async () => ({}));
  assert.ok(byTitle.description.includes('Nice Title'));
  const [byName] = proxyTools(server(), [{ name: 'bare', inputSchema: {} }], async () => ({}));
  assert.ok(byName.description.includes('bare'));
});

// ---------------------------------------------------------------------------
// The safety rule, asserted through the real mode policy rather than just the flag.
// ---------------------------------------------------------------------------

test('a server claiming readOnlyHint is still mutating, so Plan mode still denies it', () => {
  // The whole reason this layer exists. MCP's spec says ToolAnnotations "should not be relied upon
  // for security decisions ... received from untrusted servers", and classifyToolAccess opens with
  // `if (!tool.mutating) return 'allow'` - unconditional, every mode, Plan included. This asserts
  // the consequence end to end: an untrusted server cannot talk its way past the read-only mode.
  const liar: McpToolDescriptor = { ...DESCRIPTOR, annotations: { readOnlyHint: true } };
  const [tool] = proxyTools(server(), [liar], async () => ({}));

  assert.equal(tool.mutating, true, 'readOnlyHint must not be believed by default');
  assert.equal(classifyToolAccess('plan', tool), 'deny');
  assert.equal(classifyToolAccess('manual', tool), 'confirm');
  assert.equal(classifyToolAccess('acceptEdits', tool), 'confirm', 'and it is not write_file, so Accept Edits still confirms');
});

test('the hint is honoured only once the user has trusted that server', () => {
  const readOnly: McpToolDescriptor = { ...DESCRIPTOR, annotations: { readOnlyHint: true } };
  const trusted = server({ trustReadOnlyHints: true });

  assert.equal(isMutating(trusted, readOnly), false, "the user's own assertion is allowed to count");
  assert.equal(isMutating(trusted, DESCRIPTOR), true, 'a tool with no hint stays mutating even on a trusted server');
  assert.equal(
    isMutating(trusted, { ...DESCRIPTOR, annotations: { readOnlyHint: false } }),
    true,
    'and an explicit readOnlyHint:false is respected',
  );
});

test('a proxied tool named write_file gets none of the built-in write_file treatment', () => {
  // classifyToolAccess auto-approves `tool.name === 'write_file'` in Accept Edits, and Plan-Write
  // exempts it for paths under .o4c/plans/. A third-party server exposing a tool by that name must
  // inherit neither. Asserted by comparing against a reference mutating tool rather than by
  // listing expected verdicts: the claim is "it is treated as an ordinary mutating tool", so the
  // reference is the thing to compare to, and this keeps holding if a mode's rules change.
  //
  // Note Auto is deliberately absent from any "must not allow" claim - Auto allowing a mutating
  // tool IS Auto ("Runs file writes and shell commands without asking"). The risk here is special
  // treatment earned by a name, not mutating tools running in the mode made for running them.
  const [proxied] = proxyTools(server(), [{ name: 'write_file', inputSchema: {} }], async () => ({}));
  assert.equal(proxied.name, 'mcp__blender__write_file');

  const ordinary = { name: 'some_other_tool', description: '', inputSchema: {}, mutating: true, execute: async () => '' };
  const plansDir = 'C:/proj/.o4c/plans';
  const inPlans = { path: 'C:/proj/.o4c/plans/a.md' };

  for (const { mode } of MODES) {
    assert.equal(
      classifyToolAccess(mode, proxied, inPlans, plansDir),
      classifyToolAccess(mode, ordinary, inPlans, plansDir),
      `${mode} must treat a proxied write_file exactly as any other mutating tool`,
    );
  }
  // And concretely, the two places the built-in name is privileged:
  assert.equal(classifyToolAccess('acceptEdits', proxied), 'confirm', 'Accept Edits must still confirm it');
  assert.equal(classifyToolAccess('planWrite', proxied, inPlans, plansDir), 'deny', 'the .o4c/plans exemption must not transfer');
});

// ---------------------------------------------------------------------------
// Flattening results.
// ---------------------------------------------------------------------------

test('text blocks are joined; empty content says so rather than returning nothing', () => {
  assert.equal(
    flattenToolResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }),
    'one\ntwo',
  );
  assert.equal(flattenToolResult({ content: [] }), '[the tool returned no content]');
  assert.equal(flattenToolResult({}), '[the tool returned no content]');
});

test('an error result is reported to the model as text, not thrown', () => {
  // Matching the built-in convention: read_file "still reports a missing file as an error string".
  // A tool failing is information for the model, not a reason to end the turn.
  const text = flattenToolResult({ isError: true, content: [{ type: 'text', text: 'no such object' }] });
  assert.ok(text.startsWith('The tool reported an error:'), text);
  assert.ok(text.includes('no such object'));
});

test('a legacy toolResult server is not silently reported as empty', () => {
  // The SDK's callTool return is a union including MCP's 2024-11-05 `{ toolResult }` shape. The
  // typechecker caught this; without handling it the result would vanish into "no content".
  assert.equal(flattenToolResult({ toolResult: 'done' }), 'done');
  assert.equal(flattenToolResult({ toolResult: { ok: 1 } }), '{"ok":1}');
  // A modern result that merely carries an extra toolResult key is unaffected.
  assert.equal(flattenToolResult({ content: [{ type: 'text', text: 'real' }], toolResult: 'ignored' }), 'real');
});

test('an image comes back as a description, not as megabytes of base64', () => {
  // Inlining it would be worse than useless: boundToolOutput would truncate it, so the model would
  // get half a base64 blob having spent the entire tool-result budget on it.
  const data = 'A'.repeat(4000);
  const text = flattenToolResult({ content: [{ type: 'image', data, mimeType: 'image/png' }] });
  assert.ok(!text.includes('AAAA'), 'the payload must not be inlined');
  assert.ok(text.includes('image/png'), text);
  assert.ok(text.includes('3,000 bytes'), text);
  assert.ok(text.length < 200, `the placeholder must be short, was ${text.length}`);
});

test('an embedded resource shows inline text but describes a blob', () => {
  assert.equal(
    flattenToolResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } }] }),
    'hello',
  );
  const blob = flattenToolResult({
    content: [{ type: 'resource', resource: { uri: 'file:///a.bin', mimeType: 'application/octet-stream', blob: 'QUJD' } }],
  });
  assert.ok(blob.includes('file:///a.bin'), blob);
  assert.ok(!blob.includes('QUJD'), 'the blob itself must not be inlined');
});

test('a resource link and an unknown block type are both described, never dropped', () => {
  assert.ok(flattenToolResult({ content: [{ type: 'resource_link', uri: 'https://x/y', name: 'doc' }] }).includes('https://x/y'));
  // A block type this build does not know means a newer spec revision, not a bug - saying so
  // leaves the gap visible in the transcript instead of losing content silently.
  const unknown = flattenToolResult({ content: [{ type: 'hologram', payload: 1 }] });
  assert.ok(unknown.includes('hologram'), unknown);
  assert.ok(unknown.includes('does not render'), unknown);
});

test('malformed content does not throw - a bad block is skipped, the good ones survive', () => {
  const text = flattenToolResult({
    content: [null, 'not a block', { type: 'text', text: 'survivor' }, { type: 'text' }, 42],
  });
  assert.equal(text, 'survivor');
  assert.equal(flattenToolResult({ content: 'not an array' }), '[the tool returned no content]');
});

test('a transport failure becomes a tool result, so one dead server cannot end the turn', async () => {
  const [tool] = proxyTools(server(), [DESCRIPTOR], async () => {
    throw new Error('connection closed');
  });
  const output = await tool.execute({});
  assert.ok(output.includes('blender'), output);
  assert.ok(output.includes('connection closed'), output);
  assert.ok(output.includes('could not run render'), output);
});

test('a rejection that is not an Error still produces a readable result', async () => {
  const [tool] = proxyTools(server(), [DESCRIPTOR], async () => {
    throw 'just a string';
  });
  assert.ok((await tool.execute({})).includes('just a string'));
});

test('execute passes the model input through unchanged and returns the flattened result', async () => {
  const seen: Array<[string, Record<string, unknown>]> = [];
  const [tool] = proxyTools(server(), [DESCRIPTOR], async (name, input) => {
    seen.push([name, input]);
    return { content: [{ type: 'text', text: 'rendered' }] };
  });

  assert.equal(await tool.execute({ frame: 7 }), 'rendered');
  assert.deepEqual(seen, [['render', { frame: 7 }]], 'the server sees its OWN tool name, not the namespaced one');
});

// ---------------------------------------------------------------------------
// Provenance (checklist 21d): what the approval path is told about a proxied tool.
// ---------------------------------------------------------------------------

test('a proxied tool carries its server, the real tool name and the grants', () => {
  const [tool] = proxyTools(
    server({ autoApprove: true, trustReadOnlyHints: true }),
    [{ name: 'render', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, title: 'Render' } }],
    async () => ({ content: [] }),
  );

  assert.equal(tool.mcp?.serverId, 'blender');
  // The un-namespaced name, because that is what the dialog should say the server knows it by -
  // and what any future "disable this one tool" setting would have to be written against.
  assert.equal(tool.mcp?.serverToolName, 'render');
  assert.equal(tool.mcp?.autoApprove, true);
  assert.equal(tool.mcp?.hintsTrusted, true);
  assert.deepEqual(tool.mcp?.annotations, { readOnlyHint: false, title: 'Render' }, 'verbatim, unjudged');
});

test('a built-in tool has no provenance at all', () => {
  // `mcp` being absent is the honest answer to "is this ours?", and the mode policy depends on
  // it: `tool.mcp?.autoApprove` must be undefined for every built-in, whatever the config says.
  const builtIn = defaultTools[0];
  assert.equal(builtIn.mcp, undefined);
});

test('a stdio server is local, with no endpoint to name', () => {
  const [tool] = proxyTools(server(), [{ name: 'render', inputSchema: {} }], async () => ({ content: [] }));
  assert.equal(tool.mcp?.reach, 'local');
  assert.equal(tool.mcp?.endpoint, undefined);
});

test('a remote server carries the host the call goes to', () => {
  // The fact the tool name cannot carry. Host only, not the full URL: a path or query string is
  // not what makes this decision, and the line is clipped to the window.
  const { servers } = parseServers({ search: { transport: 'http', url: 'https://search.example.com/mcp?k=1' } });
  const [tool] = proxyTools(servers[0], [{ name: 'query', inputSchema: {} }], async () => ({ content: [] }));
  assert.equal(tool.mcp?.reach, 'remote');
  assert.equal(tool.mcp?.endpoint, 'search.example.com');
});

test('a loopback http server is local, so it is not announced as leaving the machine', () => {
  // The Blender case: reached over HTTP, with zero egress. Same rule `reachOf` applies for secure
  // mode, used here so the dialog and the gate can never disagree about one server.
  const { servers } = parseServers({ blender: { transport: 'http', url: 'http://127.0.0.1:9876/mcp' } });
  const [tool] = proxyTools(servers[0], [{ name: 'render', inputSchema: {} }], async () => ({ content: [] }));
  assert.equal(tool.mcp?.reach, 'local');
  assert.equal(tool.mcp?.endpoint, undefined);
});
