import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolAccess, modeInfo, MODES } from '../ui/modePolicy.js';
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

test('modeInfo returns the expected label and standard-palette color for each mode', () => {
  assert.deepEqual(modeInfo('manual'), { mode: 'manual', label: 'Manual', color: 'white' });
  assert.deepEqual(modeInfo('auto'), { mode: 'auto', label: 'Auto', color: 'yellow' });
  assert.deepEqual(modeInfo('acceptEdits'), {
    mode: 'acceptEdits',
    label: 'Accept Edits',
    color: 'magenta',
  });
  assert.deepEqual(modeInfo('plan'), { mode: 'plan', label: 'Plan', color: 'blue' });
});
