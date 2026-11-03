import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { customModeGate, findCustomMode, initialCustomMode, modeCycle, nextInCycle, parseCustomModes, setCustomModes, withCustomNote } from '../ui/customModes.js';
import { MODES } from '../ui/modePolicy.js';

afterEach(() => setCustomModes([]));

test('parseCustomModes keeps valid modes and reports the rest by index', () => {
  const { modes, problems } = parseCustomModes([
    { name: 'Review', base: 'plan', note: 'Report only.' },
    { name: 'docs', base: 'acceptEdits', tools: ['read_file', 'write_file'], color: 'cyan' },
    { name: 'plan', base: 'plan' },
    { name: 'docs', base: 'auto' },
    { name: 'x y', base: 'auto' },
    { name: 'fast', base: 'turbo' },
  ]);
  assert.deepEqual(modes, [
    { name: 'review', base: 'plan', note: 'Report only.' },
    { name: 'docs', base: 'acceptEdits', tools: ['read_file', 'write_file'], color: 'cyan' },
  ]);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /"plan" is a built-in mode's name/);
  assert.match(problems.join('\n'), /"docs" is defined twice/);
  assert.match(problems.join('\n'), /"base" must be one of/);
  assert.match(parseCustomModes('nope').problems[0]!, /must be a list/);
});

test('Tab cycles the built-in modes, then the custom ones, then wraps', () => {
  const { modes } = parseCustomModes([{ name: 'review', base: 'plan' }, { name: 'docs', base: 'acceptEdits' }]);
  setCustomModes(modes, 'docs');
  assert.equal(modeCycle().length, MODES.length + 2);
  const last = MODES[MODES.length - 1]!.mode;
  assert.deepEqual(nextInCycle(last, undefined), { mode: 'plan', custom: modes[0] });
  assert.deepEqual(nextInCycle('plan', modes[0]), { mode: 'acceptEdits', custom: modes[1] });
  assert.deepEqual(nextInCycle('acceptEdits', modes[1]), { mode: MODES[0]!.mode });
  assert.equal(initialCustomMode()?.name, 'docs');
  assert.equal(findCustomMode(' Review ')?.name, 'review');
});

test('a custom mode limits tools and adds its note to the instruction', () => {
  const docs = { name: 'docs', base: 'acceptEdits' as const, tools: ['read_file'], note: 'Markdown only.' };
  assert.equal(customModeGate(docs, 'read_file'), undefined);
  assert.equal(customModeGate(docs, 'run_shell'), 'the "docs" mode allows only read_file');
  assert.equal(customModeGate(undefined, 'run_shell'), undefined);
  assert.equal(withCustomNote('Base text.', docs), 'Base text.\n\nMode "docs": Markdown only.');
  assert.equal(withCustomNote('Base text.', undefined), 'Base text.');
});
