/**
 * `/think`'s five levels, and what each one actually sends to each provider.
 *
 * Why this exists: reasoning is the dominant cost of a local run. Measured 2026-10-06 over a real
 * 62.8-minute session, think generation was **80% of wall clock** (3,032s across 106 blocks,
 * averaging 28.6s, worst 218.9s), and the 2026-10-07 spec run hit the `max_tokens` ceiling fourteen
 * times on reasoning alone. The standing decision was that no reasoning-budget tuning happens until
 * this command exists, so this module is the gate on that whole thread.
 *
 * Pure and provider-agnostic on purpose, the same shape as `compaction.ts`'s
 * `compactionSettingsForWindow()` and `tools/toolOutput.ts`'s budgets: level in, parameters out.
 * Nothing here performs I/O, reads config or knows about the UI.
 *
 * Everything below was measured against a live llama.cpp + Qwen3 server, not taken from docs - the
 * first attempt at this got two answers wrong by probing with a trivial prompt ("what is 17*23"),
 * where reasoning is short no matter what you ask for. See `MEASURED` for the numbers and
 * `src/test/thinkLevel.test.ts` for the cases they produced.
 */

export type ThinkLevel = 'nothink' | 'low' | 'med' | 'high' | 'xhigh';

/** Ordered weakest to strongest - the order the picker shows, and the order a future cycle key
 * would step through. */
export const THINK_LEVELS: readonly ThinkLevel[] = ['nothink', 'low', 'med', 'high', 'xhigh'];

/**
 * Changed from `xhigh` to `med` on 2026-10-09, by explicit decision, and it is a real behaviour
 * change rather than a neutral one: `xhigh` was an unrestricted budget, exactly what the server
 * did before this command existed, so until now a user who never ran `/think` saw no difference.
 * From here, reasoning is capped at 2,048 tokens unless they ask for more.
 *
 * Worth it because of what the ladder measured (see `MEASURED`): on the same hard prompt, `med`
 * finished in 107s against `xhigh`'s 376s, and reasoning was already 80% of wall clock on a real
 * session. The cost is that a genuinely hard problem now gets a shaped think block instead of an
 * unbounded one - `/think high` or `/think xhigh` is one command away, and the footer always says
 * which level is live.
 *
 * Only a fallback: a level stored for this model (`thinkLevelByModel` in config) wins over it, so
 * changing this moves the default for new models and fresh installs, not for a model already set.
 */
export const DEFAULT_THINK_LEVEL: ThinkLevel = 'med';

export function isThinkLevel(value: unknown): value is ThinkLevel {
  return typeof value === 'string' && (THINK_LEVELS as readonly string[]).includes(value);
}

/**
 * Accepts what a user would plausibly type after `/think`, so `/think no-think`, `/think none` and
 * `/think medium` all land somewhere sensible instead of erroring. Returns `undefined` for anything
 * unrecognised, so the caller can open the picker rather than guess.
 */
export function parseThinkLevel(input: string): ThinkLevel | undefined {
  const key = input.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, ThinkLevel> = {
    nothink: 'nothink',
    no: 'nothink',
    none: 'nothink',
    off: 'nothink',
    zero: 'nothink',
    low: 'low',
    min: 'low',
    minimal: 'low',
    med: 'med',
    medium: 'med',
    mid: 'med',
    normal: 'med',
    high: 'high',
    xhigh: 'xhigh',
    extra: 'xhigh',
    max: 'xhigh',
    full: 'xhigh',
    on: 'xhigh',
  };
  return aliases[key];
}

export interface ThinkLevelInfo {
  level: ThinkLevel;
  /** Shown in the status bar - short, because it shares a line with five other segments. */
  label: string;
  /** Shown in the picker. Kept to one line at 100 columns per CLAUDE.md's picker rules
   * (`src/test/pickerRows.test.ts` fails on a longer row). */
  description: string;
}

export const THINK_LEVEL_INFO: Record<ThinkLevel, ThinkLevelInfo> = {
  // Not "fastest": measured 2026-10-09, nothink was 4.2x SLOWER than low on a hard prompt (166s
  // vs 39s, three samples each), because the model works the problem out in the answer instead.
  // See MEASURED. It is the quick option for edits and lookups, not for anything that needs thought.
  nothink: { level: 'nothink', label: 'nothink', description: 'No reasoning block - quickest for edits and lookups, slow on hard problems.' },
  low: { level: 'low', label: 'low', description: 'Brief reasoning, about 512 tokens - the fastest level on a problem that needs any.' },
  med: { level: 'med', label: 'med', description: 'Moderate reasoning, about 2,048 tokens - the default, a sensible everyday middle.' },
  high: { level: 'high', label: 'high', description: 'Deep reasoning, about 8,192 tokens - for genuinely hard problems.' },
  xhigh: { level: 'xhigh', label: 'xhigh', description: 'Unrestricted reasoning, no budget at all - the slowest by a wide margin.' },
};

/**
 * Hard per-level thinking budgets for the local provider, in tokens. `-1` is llama.cpp's
 * "unrestricted"; `nothink` has no budget because it switches thinking off entirely instead (see
 * `BROKEN_ZERO_BUDGET`).
 *
 * Sized against measured behaviour rather than round numbers: a reasoning-provoking puzzle prompt
 * naturally spends ~1,000 tokens thinking, and the 2026-10-07 spec run produced think blocks up to
 * ~10,000 tokens (41,139 chars at the measured 4.10 chars/token for reasoning text). So `low` and
 * `med` bite on everyday work, `high` only clips the genuinely runaway blocks, and `xhigh` never
 * clips at all.
 */
export const THINK_BUDGET_TOKENS: Record<ThinkLevel, number | undefined> = {
  nothink: undefined,
  low: 512,
  med: 2_048,
  high: 8_192,
  xhigh: -1,
};

/**
 * The template's own effort levels, layered on top of the hard budget. This is advisory - the
 * template injects a sentence of guidance ("keep your thinking brief and focused" for `low`,
 * "think carefully, validate key assumptions" for `xhigh`) and the model may ignore it. The budget
 * is what is actually enforced. Both are sent because they reinforce each other: steering shapes
 * the reasoning, the budget bounds it.
 *
 * `high` maps to `xhigh` here deliberately: Qwen3's template accepts only `low`/`medium`/`xhigh`,
 * so there is no distinct effort string for it - but `high` is still a genuinely distinct level,
 * because its 8,192-token budget differs from `xhigh`'s unrestricted one. The level never collapses;
 * only this advisory string is shared.
 */
export const THINK_EFFORT: Record<ThinkLevel, string | undefined> = {
  nothink: undefined,
  low: 'low',
  med: 'medium',
  high: 'xhigh',
  xhigh: 'xhigh',
};

/**
 * `reasoning_budget_tokens: 0` must never be sent. Measured 2026-10-07, three samples: it does NOT
 * disable thinking (4,091 / 6,674 / 3,610 chars of reasoning came back anyway) and one of the three
 * returned an **empty final answer**. `nothink` uses `enable_thinking: false`, which was verified
 * clean - zero reasoning, answer intact. Exported so a test can assert the zero is never produced.
 */
export const BROKEN_ZERO_BUDGET = 0;

/** What a model's chat template will actually accept, discovered at startup rather than assumed -
 * see `probeThinkCaps()` in the provider layer. */
export interface ThinkCaps {
  /** Effort strings the template accepts. Empty when the template takes no effort parameter. */
  efforts: readonly string[];
  /** Whether `enable_thinking: false` turns reasoning off. Without it, `nothink` cannot be honoured. */
  supportsEnableThinking: boolean;
  /** Whether per-request `reasoning_budget_tokens` is honoured. Without it the middle levels have no
   * enforcement and degrade to effort steering alone. */
  supportsBudget: boolean;
}

/**
 * Pulls the accepted effort levels out of the chat template's own error message.
 *
 * Sending a deliberately invalid `reasoning_effort` is the cheapest possible capability check:
 * measured at **0.01s**, because the template raises while rendering, before any generation starts.
 * Qwen3's message is literally
 * `Unexpected reasoning effort __x__. Supported types are xhigh (default), medium, and low.`
 * so the accepted set comes straight from the model rather than from a registry we would have to
 * keep current as new models appear.
 *
 * Returns an empty array when the message is not of that shape, which the caller treats as "no
 * effort control" rather than guessing - a wrong guess here means every request 500s.
 */
export function parseSupportedEfforts(message: string): string[] {
  const match = /Supported types are ([^.]+)/i.exec(message);
  if (!match) return [];
  const known = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'];
  const found = new Set<string>();
  // Word-by-word rather than splitting on commas: the message interleaves prose ("(default)",
  // "and") with the levels, and the exact punctuation is the template author's choice, not an API.
  for (const word of match[1].toLowerCase().split(/[^a-z]+/)) {
    if (known.includes(word)) found.add(word);
  }
  // Template order is not meaningful; ours is, so callers can present them weakest-first.
  return known.filter((k) => found.has(k));
}

/** What PHOEBE's Qwen3 reports, and a reasonable assumption for any thinking model until probed. */
export const DEFAULT_THINK_CAPS: ThinkCaps = {
  efforts: ['low', 'medium', 'xhigh'],
  supportsEnableThinking: true,
  supportsBudget: true,
};

/** A model that does no reasoning, or whose template exposes no controls: only `xhigh` (leave it
 * alone) is meaningful. */
export const NO_THINK_CAPS: ThinkCaps = {
  efforts: [],
  supportsEnableThinking: false,
  supportsBudget: false,
};

/** Extra body fields for a local (llama.cpp / OpenAI-compatible) request. */
export interface LocalThinkParams {
  chat_template_kwargs?: { enable_thinking: boolean };
  reasoning_effort?: string;
  reasoning_budget_tokens?: number;
}

/**
 * Builds the request fields for one level, given what the model can honour and how many output
 * tokens this request is allowed in total.
 *
 * `maxOutputTokens` caps the budget because a thinking budget above the output ceiling cannot bind -
 * `dynamicMaxTokens` is `min(32768, window/4)`, and the window itself moves with the server's
 * `--parallel` setting (229,376 at 1 slot, 57,344 at 4), so a fixed budget would quietly stop
 * meaning anything on a smaller slot. `-1` is passed through untouched: unrestricted already
 * defers to the output ceiling.
 *
 * Fields the model cannot honour are omitted rather than sent and ignored, which keeps the request
 * honest and avoids the template-render 500 an unsupported effort string causes.
 */
export function localThinkParams(
  level: ThinkLevel,
  caps: ThinkCaps = DEFAULT_THINK_CAPS,
  maxOutputTokens?: number,
): LocalThinkParams {
  if (level === 'nothink') {
    // Only expressible by switching thinking off. If the template cannot, say nothing rather than
    // send the broken zero budget - the caller shows the user what actually took effect.
    return caps.supportsEnableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {};
  }

  const params: LocalThinkParams = {};

  const effort = THINK_EFFORT[level];
  if (effort && caps.efforts.includes(effort)) params.reasoning_effort = effort;

  const budget = THINK_BUDGET_TOKENS[level];
  if (caps.supportsBudget && budget !== undefined && budget !== BROKEN_ZERO_BUDGET) {
    params.reasoning_budget_tokens =
      budget > 0 && maxOutputTokens !== undefined && maxOutputTokens > 0
        ? Math.min(budget, maxOutputTokens)
        : budget;
  }

  return params;
}

/**
 * The level that will genuinely take effect, which can be weaker than the one asked for on a model
 * missing the controls. The status bar shows this rather than the requested level, so the footer
 * never claims something the request did not actually do.
 */
export function effectiveThinkLevel(level: ThinkLevel, caps: ThinkCaps = DEFAULT_THINK_CAPS): ThinkLevel {
  if (level === 'nothink') return caps.supportsEnableThinking ? 'nothink' : 'xhigh';
  // Without a budget the middle levels are steering-only; they are still distinguishable when the
  // template has the effort strings, but `high` and `xhigh` share one, so `high` genuinely collapses.
  if (!caps.supportsBudget && level === 'high') return 'xhigh';
  return level;
}

/** Anthropic's own effort scale (`output_config.effort`), which already has five real levels.
 * `nothink` is the absence of a thinking block, not a level, so it maps to `undefined`. */
export function anthropicThinkEffort(level: ThinkLevel): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (level) {
    case 'nothink':
      return undefined;
    case 'low':
      return 'low';
    case 'med':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
  }
}

/**
 * The raw measurements this module's choices rest on, kept next to the code so the next person does
 * not re-derive them (it took several rounds, and two wrong conclusions, to get these).
 *
 * `reasoning_budget_tokens`, 3 samples each, reasoning chars / answer chars, against a prompt that
 * provokes long reasoning:
 * ```
 *   64  ->  351, 271, 297     / 3027, 1157, 967    answered
 *  256  -> 1055, 1128, 1199   / 1123,  848, 1425   answered
 * 1024  -> 4093, 4338, 3679   / 1143, 1399, 1330   answered
 *   -1  -> 3535, 4190, 4290   /  871, 1369, 2035   answered
 *    0  -> 4091, 6674, 3610   / 1218,    0, 1312   NOT disabled, and one empty answer
 * ```
 * Monotonic, repeatable, ~4 chars per budgeted token.
 *
 * Ignored entirely (do not re-try): `reasoning_budget` without the `_tokens` suffix,
 * `thinking_budget`, `max_reasoning_tokens`, and both `chat_template_kwargs` spellings of either.
 * `thinking.budget_tokens` (Anthropic's spelling) is accepted and ignored. `reasoning_format:
 * 'none'` hides `reasoning_content` but leaks raw `<think>` into the answer.
 *
 * End-to-end ladder, 2026-10-09, same server, one constraint-puzzle prompt, request bodies built
 * by `localThinkParams()` itself rather than by hand:
 *
 * ```
 * level     reasoning   answer    wall     samples
 * nothink          0   ~27,400c    166s    3   exactly zero reasoning every time
 * low          1,420    2,663c      39s    3
 * med          6,500   12,791c     107s    1
 * high        27,926    1,715c     157s    1   ~6,800 of its 8,192 budget, never clipped
 * xhigh       63,806    3,490c     376s    1
 * ```
 *
 * Two things that fall out of this and are not obvious:
 *
 * 1. **Reasoning and answer trade against each other.** Reasoning off does not remove the work,
 *    it relocates it into the visible answer - `nothink` wrote the LONGEST answers of any level.
 * 2. **`nothink` is therefore not the fast option on a hard prompt: it was 4.2x SLOWER than
 *    `low`** (166s vs 39s, three samples each). It is the fast option only where there was
 *    nothing to reason about. The picker's wording says so because of this measurement.
 *
 * The budgets shape reasoning rather than truncating it - every level finished on `stop`, none on
 * `length`, and the middle levels came in under their caps.
 */
export const MEASURED = {
  budgetIsGraduated: true,
  zeroBudgetIsBroken: true,
  charsPerReasoningToken: 4.1,
  /** `nothink` spends its tokens on the answer instead, so it is slower than `low` on anything
   * that genuinely needs reasoning. Measured 166s vs 39s, three samples each. */
  nothinkIsNotTheFastest: true,
} as const;
