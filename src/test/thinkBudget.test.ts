import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THINK_CAPS,
  localThinkParams,
  parseThinkBudget,
  savedThinkBudget,
  setThinkBudgetOverride,
  THINK_BUDGET_CONFIG_KEY,
  thinkBudgetOverride,
} from '../agent/thinkLevel.js';

afterEach(() => setThinkBudgetOverride(undefined));

test('parseThinkBudget reads plain, k-suffixed and grouped numbers in range', () => {
  assert.equal(parseThinkBudget('4000'), 4000);
  assert.equal(parseThinkBudget('4k'), 4000);
  assert.equal(parseThinkBudget('16K'), 16000);
  assert.equal(parseThinkBudget('1,500'), 1500);
  assert.equal(parseThinkBudget('high'), undefined);
  assert.equal(parseThinkBudget('50'), undefined, 'below the minimum');
  assert.equal(parseThinkBudget('500k'), undefined, 'above the maximum');
});

test('savedThinkBudget reads the per-model entry and ignores junk', () => {
  const config = { [THINK_BUDGET_CONFIG_KEY]: { qwen: 6000, other: 'lots' } };
  assert.equal(savedThinkBudget(config, 'qwen'), 6000);
  assert.equal(savedThinkBudget(config, 'other'), undefined);
  assert.equal(savedThinkBudget(config, undefined), undefined);
  assert.equal(savedThinkBudget({}, 'qwen'), undefined);
});

test('an override replaces the level budget in the request, and clearing it restores the level one', () => {
  const caps = { ...DEFAULT_THINK_CAPS, supportsBudget: true };
  assert.equal(localThinkParams('med', caps).reasoning_budget_tokens, 2048);
  setThinkBudgetOverride(5000);
  assert.equal(thinkBudgetOverride(), 5000);
  const p = localThinkParams('med', caps);
  assert.equal(p.reasoning_budget_tokens, 5000);
  assert.ok(p.reasoning_budget_message, 'the budget message goes with it');
  assert.equal(localThinkParams('med', caps, 3000).reasoning_budget_tokens, 3000, 'still capped by the output ceiling');
  assert.equal(localThinkParams('nothink', { ...caps, supportsEnableThinking: true }).reasoning_budget_tokens, undefined, 'nothink stays off');
  setThinkBudgetOverride(undefined);
  assert.equal(localThinkParams('med', caps).reasoning_budget_tokens, 2048);
});
