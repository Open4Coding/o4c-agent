import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROKEN_ZERO_BUDGET,
  DEFAULT_THINK_CAPS,
  DEFAULT_THINK_LEVEL,
  NO_THINK_CAPS,
  THINK_BUDGET_TOKENS,
  THINK_LEVELS,
  THINK_LEVEL_INFO,
  anthropicThinkEffort,
  effectiveThinkLevel,
  isThinkLevel,
  localThinkParams,
  parseSupportedEfforts,
  parseThinkLevel,
  type ThinkCaps,
  type ThinkLevel,
} from '../agent/thinkLevel.js';

test('the five levels are ordered weakest to strongest', () => {
  assert.deepEqual([...THINK_LEVELS], ['nothink', 'low', 'med', 'high', 'xhigh']);
  for (const level of THINK_LEVELS) assert.ok(isThinkLevel(level));
  assert.ok(!isThinkLevel('medium'));
  assert.ok(!isThinkLevel(undefined));
});

test('the default is a shaped budget, a deliberate change from the unrestricted original', () => {
  // Was xhigh (unrestricted, i.e. what the server did before /think existed) until 2026-10-09.
  // The point of pinning it is that moving it is a real behaviour change for every user who never
  // runs /think, so it should take a failing test to do it by accident.
  assert.equal(DEFAULT_THINK_LEVEL, 'med');
  assert.equal(THINK_BUDGET_TOKENS[DEFAULT_THINK_LEVEL], 2_048);
  // And xhigh still means unrestricted, for anyone who wants the old behaviour back.
  assert.equal(THINK_BUDGET_TOKENS.xhigh, -1);
  const params = localThinkParams('xhigh');
  assert.equal(params.reasoning_budget_tokens, -1, 'unrestricted is what the server already did');
});

test('budgets rise strictly with the level', () => {
  const budgets = (['low', 'med', 'high'] as ThinkLevel[]).map((l) => THINK_BUDGET_TOKENS[l] as number);
  assert.deepEqual(budgets, [512, 2_048, 8_192]);
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(budgets[i] > budgets[i - 1], `level ${i} must exceed level ${i - 1}`);
  }
});

test('nothink switches thinking off and never sends a budget', () => {
  // Measured: reasoning_budget_tokens:0 does NOT disable thinking and produced an empty answer in
  // one of three samples. enable_thinking:false was verified clean.
  const params = localThinkParams('nothink');
  assert.deepEqual(params, { chat_template_kwargs: { enable_thinking: false } });
  assert.equal(params.reasoning_budget_tokens, undefined);
});

test('no level can ever emit the broken zero budget', () => {
  for (const level of THINK_LEVELS) {
    for (const caps of [DEFAULT_THINK_CAPS, NO_THINK_CAPS]) {
      for (const max of [undefined, 1, 100, 32_768]) {
        const sent = localThinkParams(level, caps, max).reasoning_budget_tokens;
        assert.notEqual(sent, BROKEN_ZERO_BUDGET, `${level} with max=${max} emitted a zero budget`);
      }
    }
  }
});

test('each thinking level sends the budget and the effort string together', () => {
  assert.deepEqual(localThinkParams('low'), { reasoning_effort: 'low', reasoning_budget_tokens: 512 });
  assert.deepEqual(localThinkParams('med'), { reasoning_effort: 'medium', reasoning_budget_tokens: 2_048 });
  assert.deepEqual(localThinkParams('high'), { reasoning_effort: 'xhigh', reasoning_budget_tokens: 8_192 });
  assert.deepEqual(localThinkParams('xhigh'), { reasoning_effort: 'xhigh', reasoning_budget_tokens: -1 });
});

test('high and xhigh share an effort string but stay distinct levels', () => {
  // Qwen3's template accepts only low/medium/xhigh, so there is no distinct `high` effort - but the
  // budget is what is enforced, and those differ, so the level does not collapse.
  const high = localThinkParams('high');
  const xhigh = localThinkParams('xhigh');
  assert.equal(high.reasoning_effort, xhigh.reasoning_effort);
  assert.notEqual(high.reasoning_budget_tokens, xhigh.reasoning_budget_tokens);
  assert.equal(effectiveThinkLevel('high'), 'high', 'with a budget, high is genuinely its own level');
});

test('the budget is capped by the output ceiling, which moves with the window', () => {
  // dynamicMaxTokens is min(32768, window/4): 57,344 at --parallel 4 gives 14,336, so `high`'s
  // 8,192 still fits; a 4,096 window gives 1,024, where it must not claim 8,192.
  assert.equal(localThinkParams('high', DEFAULT_THINK_CAPS, 14_336).reasoning_budget_tokens, 8_192);
  assert.equal(localThinkParams('high', DEFAULT_THINK_CAPS, 1_024).reasoning_budget_tokens, 1_024);
  assert.equal(localThinkParams('med', DEFAULT_THINK_CAPS, 512).reasoning_budget_tokens, 512);
  // Unrestricted stays unrestricted - it already defers to the output ceiling server-side.
  assert.equal(localThinkParams('xhigh', DEFAULT_THINK_CAPS, 1_024).reasoning_budget_tokens, -1);
});

test('a model with no reasoning controls is sent none of them', () => {
  for (const level of THINK_LEVELS) {
    assert.deepEqual(localThinkParams(level, NO_THINK_CAPS), {}, `${level} must send nothing`);
  }
});

test('an effort string the template would reject is omitted, not sent', () => {
  // Sending an unsupported effort is not harmless: the template raises and the request 500s.
  const budgetOnly: ThinkCaps = { efforts: [], supportsEnableThinking: true, supportsBudget: true };
  const params = localThinkParams('low', budgetOnly);
  assert.equal(params.reasoning_effort, undefined);
  assert.equal(params.reasoning_budget_tokens, 512, 'the enforced part still goes');

  const noXhigh: ThinkCaps = { efforts: ['low', 'medium'], supportsEnableThinking: true, supportsBudget: true };
  assert.equal(localThinkParams('high', noXhigh).reasoning_effort, undefined);
  assert.equal(localThinkParams('med', noXhigh).reasoning_effort, 'medium');
});

test('the effective level tells the truth when a control is missing', () => {
  assert.equal(effectiveThinkLevel('nothink', DEFAULT_THINK_CAPS), 'nothink');
  // Cannot switch thinking off: nothink is not honoured, so do not claim it in the footer.
  assert.equal(effectiveThinkLevel('nothink', NO_THINK_CAPS), 'xhigh');
  // Without budget enforcement, high and xhigh send the same advisory string and nothing else.
  const steeringOnly: ThinkCaps = { efforts: ['low', 'medium', 'xhigh'], supportsEnableThinking: true, supportsBudget: false };
  assert.equal(effectiveThinkLevel('high', steeringOnly), 'xhigh');
  assert.equal(effectiveThinkLevel('low', steeringOnly), 'low', 'low still has its own effort string');
});

test('Anthropic maps to its own five efforts, with nothink meaning no thinking block', () => {
  assert.equal(anthropicThinkEffort('nothink'), undefined);
  assert.equal(anthropicThinkEffort('low'), 'low');
  assert.equal(anthropicThinkEffort('med'), 'medium');
  assert.equal(anthropicThinkEffort('high'), 'high');
  assert.equal(anthropicThinkEffort('xhigh'), 'xhigh');
});

test('what a user would plausibly type after /think is accepted', () => {
  assert.equal(parseThinkLevel('nothink'), 'nothink');
  assert.equal(parseThinkLevel('no think'), 'nothink');
  assert.equal(parseThinkLevel('no-think'), 'nothink');
  assert.equal(parseThinkLevel('  OFF '), 'nothink');
  assert.equal(parseThinkLevel('medium'), 'med');
  assert.equal(parseThinkLevel('MED'), 'med');
  assert.equal(parseThinkLevel('max'), 'xhigh');
  assert.equal(parseThinkLevel('xhigh'), 'xhigh');
  assert.equal(parseThinkLevel('banana'), undefined, 'unknown input opens the picker instead');
  assert.equal(parseThinkLevel(''), undefined);
});

test('every level has picker text short enough for a picker row', () => {
  for (const level of THINK_LEVELS) {
    const info = THINK_LEVEL_INFO[level];
    assert.equal(info.level, level);
    assert.ok(info.label.length > 0 && info.label.length <= 8, `${level} label is status-bar sized`);
    // CLAUDE.md: 1-3 lines at 100 columns, aim for 2 or fewer. The row is "label - description".
    assert.ok(
      `${info.label} - ${info.description}`.length <= 100,
      `${level} row is ${info.description.length} chars and would wrap`,
    );
  }
});

test('the capability probe reads the accepted levels out of the real error body', () => {
  // The exact 500 body captured from PHOEBE, abbreviated only in the Jinja trace. Parsing the
  // model's own error beats keeping a per-model registry that would go stale.
  const real =
    '{"error":{"code":500,"message":"\n------------\nWhile executing CallExpression at line 49, ' +
    "column 28 in source:\n...', 'low') %}\u21b5        {{- raise_exception('Unexpected reasoning effort ' ~ " +
    'reason...\n                                           ^\nError: Jinja Exception: Unexpected ' +
    'reasoning effort __o4c_capability_probe__. Supported types are xhigh (default), medium, and low."}}';
  assert.deepEqual(parseSupportedEfforts(real), ['low', 'medium', 'xhigh']);
});

test('the parser returns them weakest-first regardless of how the template lists them', () => {
  // Template order is the author's choice; ours is meaningful, so the picker can rely on it.
  assert.deepEqual(parseSupportedEfforts('Supported types are xhigh (default), medium, and low.'), [
    'low',
    'medium',
    'xhigh',
  ]);
  assert.deepEqual(parseSupportedEfforts('Supported types are low, medium, high.'), ['low', 'medium', 'high']);
});

test('an unrecognisable message yields no efforts rather than a guess', () => {
  // A wrong guess here is not harmless: sending an effort the template rejects makes every request
  // fail with a 500, so "none" is the only safe answer when the shape is unfamiliar.
  assert.deepEqual(parseSupportedEfforts('Internal server error'), []);
  assert.deepEqual(parseSupportedEfforts(''), []);
  assert.deepEqual(parseSupportedEfforts('Supported types are banana and fruit.'), []);
});

test('the parser ignores prose words mixed in with the levels', () => {
  const caps = parseSupportedEfforts('Supported types are minimal, low, medium, high, xhigh or max.');
  assert.deepEqual(caps, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});
