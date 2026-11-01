import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CURATED_DEFAULT_CAP_TOKENS,
  contextWindowTypeControl,
  curatedBudgetTokens,
} from '../agent/contextWindowType.js';
import {
  contextWindowTypeFromConfig,
  describeContextWindowType,
  formatContextWindowType,
  parseContextWindowType,
} from '../ui/contextWindowSetting.js';

/** NextUp item 23, checklist B1: the four types and `curated`'s budget. */

test('parses the four types, case-insensitively; only curated takes a budget', () => {
  assert.deepEqual(parseContextWindowType('none'), { type: 'none' });
  assert.deepEqual(parseContextWindowType(' Floating '), { type: 'floating' });
  assert.deepEqual(parseContextWindowType('POINTER'), { type: 'pointer' });
  assert.deepEqual(parseContextWindowType('curated'), { type: 'curated' });
  assert.deepEqual(parseContextWindowType('curated 20%'), { type: 'curated', budget: { fraction: 0.2 } });
  assert.deepEqual(parseContextWindowType('curated 20000'), { type: 'curated', budget: { budgetTokens: 20000 } });
  assert.equal(parseContextWindowType('pointer 20%'), undefined);
  assert.equal(parseContextWindowType('curated lots'), undefined);
  assert.equal(parseContextWindowType('sliding'), undefined);
  assert.equal(parseContextWindowType(''), undefined);
});

test('the stored form round-trips through the parser', () => {
  for (const text of ['none', 'floating', 'pointer', 'curated', 'curated 20%', 'curated 20000']) {
    assert.equal(formatContextWindowType(parseContextWindowType(text)!), text);
  }
});

test('an unreadable saved value is the default, never an error', () => {
  assert.deepEqual(contextWindowTypeFromConfig(undefined), { type: 'floating' });
  assert.deepEqual(contextWindowTypeFromConfig('typo'), { type: 'floating' });
  assert.deepEqual(contextWindowTypeFromConfig(42), { type: 'floating' });
  assert.deepEqual(contextWindowTypeFromConfig('pointer'), { type: 'pointer' });
});

test('curated budget: 15% of the window capped at 30K by default; an explicit budget is honoured as typed', () => {
  const curated = { type: 'curated' as const };
  assert.equal(curatedBudgetTokens(curated, 32_768), 4915);
  assert.equal(curatedBudgetTokens(curated, 229_376), CURATED_DEFAULT_CAP_TOKENS);
  assert.equal(curatedBudgetTokens(curated, 1_000_000), CURATED_DEFAULT_CAP_TOKENS);
  assert.equal(curatedBudgetTokens({ type: 'curated', budget: { fraction: 0.4 } }, 1_000_000), 400_000);
  assert.equal(curatedBudgetTokens({ type: 'curated', budget: { budgetTokens: 8000 } }, undefined), 8000);
  assert.equal(curatedBudgetTokens(curated, undefined), undefined, 'never guess the window');
});

test('describe reads back in plain terms', () => {
  assert.equal(describeContextWindowType({ type: 'pointer' }), 'pointer');
  assert.match(describeContextWindowType({ type: 'curated' }), /15% of the context window \(at most 30,000 tokens\)/);
  assert.match(describeContextWindowType({ type: 'curated', budget: { budgetTokens: 8000 } }), /8,000 tokens/);
});

test('the control is shared state: a set is seen by every reader', () => {
  const control = contextWindowTypeControl({ type: 'floating' });
  const reader = () => control.current().type;
  control.set({ type: 'none' });
  assert.equal(reader(), 'none');
});
