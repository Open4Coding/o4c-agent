import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolAccess, modeInfo, modeSystemPrompt, MODES } from '../ui/modePolicy.js';
import type { Tool } from '../tools/types.js';

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
  assert.deepEqual(modeInfo('manual'), {
    mode: 'manual',
    label: 'Manual',
    description: 'Confirms every file write and shell command before running it.',
    color: 'white',
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
