import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfirmMessage } from '../ui/confirmPreview.js';
import type { McpToolProvenance } from '../tools/types.js';

const bigFile = Array.from({ length: 260 }, (_, i) => 'const row' + i + ' = ' + JSON.stringify('x'.repeat(40)) + ';').join('\n');

test('write_file shows the path, the size and a short preview - never the whole file', () => {
  const msg = formatConfirmMessage('write_file', { path: 'index.html', content: bigFile }, { cols: 100, rows: 40 });
  const lines = msg.split('\n');
  assert.ok(lines[0].startsWith('Allow write_file(index.html)?'));
  assert.ok(lines[0].includes('260 lines'));
  assert.ok(lines[1].startsWith('const row0 ='));
  assert.ok(lines.at(-1)!.startsWith('... (+'));
  assert.ok(!msg.includes('const row100 ='), 'the body of the file is not shown');
  assert.ok(lines.length <= 1 + 8 + 1);
});

test('a short write_file is shown whole, with no "more lines" note', () => {
  const msg = formatConfirmMessage('write_file', { path: 'a.txt', content: 'one' + '\n' + 'two' }, { cols: 100, rows: 40 });
  assert.equal(msg, 'Allow write_file(a.txt)? 7 characters, 2 lines' + '\n' + 'one' + '\n' + 'two');
});

test('run_shell shows a normal command in full, on its own line', () => {
  const msg = formatConfirmMessage('run_shell', { command: 'npm test -- --watch=false' }, { cols: 100, rows: 40 });
  assert.equal(msg, 'Allow run_shell?' + '\n' + 'npm test -- --watch=false');
});

test('run_shell bounds a huge command (a heredoc embedding a file) and says how long it really is', () => {
  const command = 'cat > f <<EOF' + '\n' + 'y'.repeat(5000) + '\n' + 'EOF';
  const msg = formatConfirmMessage('run_shell', { command }, { cols: 100, rows: 40 });
  assert.ok(msg.length < 1200);
  assert.ok(msg.split('\n').at(-1)!.includes('in total'));
});

test('an unknown tool falls back to a bounded JSON preview', () => {
  const msg = formatConfirmMessage('mystery', { blob: 'z'.repeat(5000) }, { cols: 100, rows: 40 });
  assert.ok(msg.startsWith('Allow mystery('));
  assert.ok(msg.length < 480);
  assert.ok(msg.endsWith('...)?'));
});

test('a long path keeps its file name and the counts stay visible', () => {
  const longPath = '/very/deep/' + 'folder/'.repeat(30) + 'important-file.ts';
  const header = formatConfirmMessage('write_file', { path: longPath, content: 'x' }, { cols: 80, rows: 40 }).split('\n')[0];
  assert.ok(header.includes('important-file.ts)?'));
  assert.ok(header.includes('1 character, 1 line'));
  assert.ok(header.length < 80 * 2);
});

test('the dialog stays small at ANY window size: bounded line count, every preview line fits the width', () => {
  for (const rows of [3, 5, 10, 24, 40, 131, 300]) {
    for (const cols of [20, 40, 80, 177, 300]) {
      const msg = formatConfirmMessage('write_file', { path: 'a/b/c.ts', content: bigFile }, { cols, rows });
      const lines = msg.split('\n');
      const budget = Math.max(20, cols - 8);
      const maxPreview = Math.max(3, Math.min(8, Math.floor(rows / 4)));
      assert.ok(lines.length <= 1 + maxPreview + 1, rows + 'x' + cols + ': ' + lines.length + ' lines');
      for (const l of lines.slice(1)) assert.ok(l.length <= budget, rows + 'x' + cols + ': preview line of ' + l.length);
    }
  }
});

// ---------------------------------------------------------------------------
// MCP provenance in the dialog (checklist 21d): shown, labelled as the server's claim, never
// acted on. `classifyToolAccess` is what acts; see modePolicy.test.ts.
// ---------------------------------------------------------------------------

const SIZE = { cols: 100, rows: 40 };

function provenance(extra: Partial<McpToolProvenance> = {}): McpToolProvenance {
  return {
    serverId: 'blender',
    serverToolName: 'render',
    reach: 'local',
    hintsTrusted: false,
    autoApprove: false,
    ...extra,
  };
}

test('a built-in tool gains no extra lines at all', () => {
  // The common case has to stay exactly as it was - no blank line, no "on this machine" for a
  // tool that was never on a server.
  const before = formatConfirmMessage('run_shell', { command: 'npm test' }, SIZE);
  assert.equal(before, 'Allow run_shell?\nnpm test');
});

test('an MCP call names its server, under the question rather than above it', () => {
  const msg = formatConfirmMessage('mcp__blender__render', { frames: 1 }, SIZE, provenance());
  const lines = msg.split('\n');
  // First line stays the question: in a window too short for the dialog that is the line
  // guaranteed to be visible, which is what this whole file exists to protect.
  assert.ok(lines[0].startsWith('Allow mcp__blender__render('), lines[0]);
  assert.ok(lines[1].includes('"blender"'), lines[1]);
  assert.ok(lines[1].includes('on this machine'), lines[1]);
});

test('a remote call says it leaves the machine, and where it goes', () => {
  // The fact a tool name cannot carry: two tools look identical and one of them is an outbound
  // request to somebody else's computer.
  const msg = formatConfirmMessage(
    'mcp__search__query',
    { q: 'x' },
    SIZE,
    provenance({ serverId: 'search', reach: 'remote', endpoint: 'search.example.com' }),
  );
  assert.ok(msg.startsWith('Allow mcp__search__query('), msg);
  // Warning first, host second. In an 80-column terminal the budget is 72 characters, and the
  // original wording ("... - this call leaves your machine") lost the warning off the end of its
  // own line - caught by the App-level test, after this one passed at 100 columns.
  assert.ok(msg.split('\n')[1].startsWith('Leaves your machine'), msg);
  assert.ok(msg.includes('search.example.com'), msg);

  const narrow = formatConfirmMessage(
    'mcp__search__query',
    { q: 'x' },
    { cols: 80, rows: 24 },
    provenance({ serverId: 'search', reach: 'remote', endpoint: 'search.example.com' }),
  );
  assert.ok(narrow.includes('Leaves your machine'), narrow);
});

test("the server's annotations are shown as its own unverified claim", () => {
  const msg = formatConfirmMessage(
    'mcp__blender__render',
    {},
    SIZE,
    provenance({ annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }),
  );
  assert.ok(msg.includes('read-only'), msg);
  assert.ok(msg.includes('non-destructive'), msg);
  assert.ok(msg.includes('reaches outside this machine'), msg);
  // The load-bearing half of the line: the user must not read a server's self-description as
  // o4c's verdict, because the spec says these hints cannot carry a security decision. It leads
  // the line rather than trailing it so that clipping can never be what removes it - a probe of
  // this exact case showed the first wording losing the disclaimer in a 100-column window.
  assert.ok(msg.includes("Server's claim, unverified:"), msg);
  for (const line of msg.split('\n')) assert.ok(line.length <= 92, line);
});

test('a server with no annotations gets no claim line invented for it', () => {
  const msg = formatConfirmMessage('mcp__blender__render', {}, SIZE, provenance());
  assert.equal(msg.split('\n').length, 2, msg);
  assert.ok(!msg.includes('claim'), msg);
});

test('trusting a server\'s hints is stated, since it explains the prompts that stop appearing', () => {
  const msg = formatConfirmMessage(
    'mcp__blender__render',
    {},
    SIZE,
    provenance({ hintsTrusted: true, annotations: { readOnlyHint: false } }),
  );
  assert.ok(msg.includes('not read-only'), msg);
  assert.ok(msg.includes("You have told o4c to believe"), msg);
});

test('the notes are clipped to the window like every other line', () => {
  const msg = formatConfirmMessage(
    'mcp__s__t',
    {},
    { cols: 40, rows: 20 },
    provenance({ serverId: 'a'.repeat(200), reach: 'remote', endpoint: 'b'.repeat(200) }),
  );
  for (const line of msg.split('\n').slice(1)) {
    assert.ok(line.length <= 40, `a note overflowed a 40-column window: ${line.length} chars`);
  }
});

test('a proxied tool named like a built-in still gets its notes', () => {
  // `write_file`/`run_shell` are matched by exact name, so a proxied tool falls to the generic
  // branch - this pins that the notes are not lost on the way there.
  const msg = formatConfirmMessage(
    'mcp__fixture__write_file',
    { path: 'x', content: 'y' },
    SIZE,
    provenance({ serverId: 'fixture', serverToolName: 'write_file' }),
  );
  assert.ok(msg.startsWith('Allow mcp__fixture__write_file('), msg);
  assert.ok(msg.includes('"fixture"'), msg);
});

test("the unverified-claim disclaimer survives a window too narrow for the claims", () => {
  // What the clipping order buys: in 40 columns the list of claims is cut, and the sentence
  // still says whose claim it was.
  const msg = formatConfirmMessage('mcp__s__t', {}, { cols: 40, rows: 20 }, provenance({
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));
  const claimLine = msg.split('\n').find((l) => l.includes('claim'));
  assert.ok(claimLine?.startsWith("Server's claim, unverified:"), JSON.stringify(claimLine));
});
