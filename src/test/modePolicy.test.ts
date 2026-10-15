import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolAccess, modeInfo, modeSystemPrompt, MODES } from '../ui/modePolicy.js';
import { theme } from '../ui/theme.js';
import type { McpToolProvenance, Tool } from '../tools/types.js';

function fakeTool(name: string, mutating: boolean): Tool {
  return {
    name,
    description: 'test tool',
    inputSchema: {},
    mutating,
    async execute() {
      return '';
    },
  };
}

const readOnly = fakeTool('read_file', false);
const writeFile = fakeTool('write_file', true);
const runShell = fakeTool('run_shell', true);

test('read-only tools are always allowed, regardless of mode', () => {
  for (const { mode } of MODES) {
    assert.equal(classifyToolAccess(mode, readOnly), 'allow');
  }
});

test('manual mode confirms both write_file and run_shell', () => {
  assert.equal(classifyToolAccess('manual', writeFile), 'confirm');
  assert.equal(classifyToolAccess('manual', runShell), 'confirm');
});

test('auto mode allows both write_file and run_shell with no confirmation', () => {
  assert.equal(classifyToolAccess('auto', writeFile), 'allow');
  assert.equal(classifyToolAccess('auto', runShell), 'allow');
});

test('acceptEdits mode allows write_file but still confirms run_shell', () => {
  assert.equal(classifyToolAccess('acceptEdits', writeFile), 'allow');
  assert.equal(classifyToolAccess('acceptEdits', runShell), 'confirm');
});

test('plan mode blocks both write_file and run_shell outright', () => {
  assert.equal(classifyToolAccess('plan', writeFile), 'deny');
  assert.equal(classifyToolAccess('plan', runShell), 'deny');
});

test('planWrite mode blocks run_shell outright, like plan', () => {
  assert.equal(classifyToolAccess('planWrite', runShell, {}, '/proj/.o4c/plans'), 'deny');
});

test('planWrite mode allows write_file only inside plansDir', () => {
  const plansDir = '/proj/.o4c/plans';
  assert.equal(
    classifyToolAccess('planWrite', writeFile, { path: '/proj/.o4c/plans/roadmap.md' }, plansDir),
    'allow',
  );
  assert.equal(
    classifyToolAccess('planWrite', writeFile, { path: '/proj/.o4c/plans/sub/roadmap.md' }, plansDir),
    'allow',
  );
  assert.equal(
    classifyToolAccess('planWrite', writeFile, { path: '/proj/src/index.ts' }, plansDir),
    'deny',
  );
  // A sibling directory that merely shares the "plans" prefix must not match via naive string
  // prefixing - relative()/resolve() based scoping is exactly what rules this out.
  assert.equal(
    classifyToolAccess('planWrite', writeFile, { path: '/proj/.o4c/plans-archive/x.md' }, plansDir),
    'deny',
  );
});

test('planWrite mode denies all writes when plansDir is undefined (no trusted project)', () => {
  assert.equal(classifyToolAccess('planWrite', writeFile, { path: '/anything.md' }, undefined), 'deny');
});

test('modeSystemPrompt gives every mode a distinct instruction naming itself', () => {
  for (const { mode, label } of MODES) {
    const text = modeSystemPrompt(mode, '/proj/.o4c/plans');
    assert.match(text, new RegExp(`Current mode: ${label}`));
  }
});

test('modeSystemPrompt tells the model plan/run_shell are hard-disabled in plan mode', () => {
  const text = modeSystemPrompt('plan');
  assert.match(text, /write_file and run_shell are both hard-disabled/);
});

test('modeSystemPrompt scopes planWrite\'s write_file allowance to the given plansDir by name', () => {
  const text = modeSystemPrompt('planWrite', '/proj/.o4c/plans');
  assert.match(text, /run_shell is hard-disabled/);
  assert.ok(text.includes('/proj/.o4c/plans'));
});

test('modeSystemPrompt for planWrite with no plansDir says nothing is writable, not a broken path', () => {
  const text = modeSystemPrompt('planWrite', undefined);
  assert.match(text, /no project is trusted yet/);
  assert.match(text, /write_file and run_shell are both hard-disabled/);
});

test('modeInfo returns the expected label and standard-palette color for each mode', () => {
  // manual is the one exception - the theme accent (amber), not a named color, per direct
  // instruction that every "white" UI text spot become amber instead.
  assert.deepEqual(modeInfo('manual'), {
    mode: 'manual',
    label: 'Manual',
    description: 'Confirms every file write and shell command before running it.',
    color: theme.accent,
  });
  assert.deepEqual(modeInfo('auto'), {
    mode: 'auto',
    label: 'Auto',
    description: 'Runs file writes and shell commands without asking.',
    color: 'yellow',
  });
  assert.deepEqual(modeInfo('acceptEdits'), {
    mode: 'acceptEdits',
    label: 'Accept Edits',
    description: 'Writes files automatically; still confirms shell commands.',
    color: 'magenta',
  });
  assert.deepEqual(modeInfo('plan'), {
    mode: 'plan',
    label: 'Plan',
    description: 'Blocks file writes and shell commands outright - read-only.',
    color: 'blue',
  });
  assert.deepEqual(modeInfo('planWrite'), {
    mode: 'planWrite',
    label: 'Plan-Write',
    description: 'Like Plan, but allows writing to plan documents under .o4c/plans/.',
    color: 'green',
  });
});

// ---------------------------------------------------------------------------
// Per-server trust: `grants.autoApprove` on a proxied MCP tool (checklist 21d).
// ---------------------------------------------------------------------------

/** A proxied MCP tool, as `proxyTools` builds it - see mcpToolProxy.test.ts for that half. */
function mcpTool(name: string, autoApprove: boolean, extra: Partial<McpToolProvenance> = {}): Tool {
  return {
    ...fakeTool(name, true),
    mcp: {
      serverId: 'plugin',
      serverToolName: name.replace('mcp__plugin__', ''),
      reach: 'local',
      hintsTrusted: false,
      autoApprove,
      ...extra,
    },
  };
}

test('an auto-approved server skips the prompt in the modes that ask', () => {
  const trusted = mcpTool('mcp__plugin__remember', true);
  assert.equal(classifyToolAccess('manual', trusted), 'allow');
  // Accept Edits confirms everything that is not the built-in write_file, so this is the other
  // asking mode and it has to behave the same way.
  assert.equal(classifyToolAccess('acceptEdits', trusted), 'allow');
});

test('auto-approve cannot get a mutating tool past Plan or Plan-Write', () => {
  // The invariant worth more than the convenience. Plan's promise is "nothing changes", and a
  // promise a line in a config file silently revokes is not a promise - so the grant may only
  // ever soften a `confirm`, which is why `classifyToolAccess` applies it in exactly one place.
  const trusted = mcpTool('mcp__plugin__remember', true);
  assert.equal(classifyToolAccess('plan', trusted), 'deny');
  assert.equal(classifyToolAccess('planWrite', trusted), 'deny');
  // Including when it is named like the tool Plan-Write does exempt, and aimed inside the plans
  // directory: the exemption is for the built-in, and a server does not inherit it by naming.
  const impostor = mcpTool('mcp__plugin__write_file', true);
  assert.equal(
    classifyToolAccess('planWrite', impostor, { path: '/project/.o4c/plans/0001.md' }, '/project/.o4c/plans'),
    'deny',
  );
});

test('without the grant, a proxied tool is confirmed exactly like any other mutating tool', () => {
  const untrusted = mcpTool('mcp__plugin__remember', false);
  for (const { mode } of MODES) {
    assert.equal(
      classifyToolAccess(mode, untrusted),
      classifyToolAccess(mode, runShell),
      `mode ${mode} must treat an ungranted MCP tool exactly as it treats run_shell`,
    );
  }
});

test('the server\'s own annotations never change a verdict - only the user\'s grant does', () => {
  // `hintsTrusted` and the annotations are display material (see confirmPreview.ts). A server
  // claiming to be harmless, loudly, in every field it has, gets exactly what any other
  // unapproved server gets.
  const boasting = mcpTool('mcp__plugin__definitely_safe', false, {
    hintsTrusted: true,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  assert.equal(classifyToolAccess('manual', boasting), 'confirm');
  assert.equal(classifyToolAccess('plan', boasting), 'deny');
});

test('a read-only proxied tool needs no grant, and a grant does not make one mutating', () => {
  const readOnlyProxy: Tool = { ...mcpTool('mcp__plugin__search', false), mutating: false };
  for (const { mode } of MODES) {
    assert.equal(classifyToolAccess(mode, readOnlyProxy), 'allow');
  }
});
