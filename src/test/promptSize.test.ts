import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, promptProfileFor, promptSections, type PromptProfile } from '../agent/systemPrompt.js';
import { defaultTools } from '../tools/index.js';
import { estimateTextTokens } from '../agent/contextEntry.js';

/**
 * Prompt-size regression guard (plan 0006 J2). "Lowest token usage" is design priority two, and
 * the fixed part of every request - system prompt plus built-in tool schemas - is paid on every
 * request of every session. It grows quietly: a longer tool description here, a new rule there.
 * This pins it. Growth beyond the tolerance fails until the pin below is updated on purpose, in
 * the same change that explains why the extra tokens are worth it.
 *
 * Pinned 2026-11-02: system 70, tools 857 (estimated tokens, chars/4).
 * Re-pinned 2026-11-02 for B1's sectioned prompt, per profile with every built-in tool plus
 * code_graph and no environment or O4C.md: default 519, qwen 756 (adds the worked example in
 * Qwen's own tool-call notation), small 119. Worth it if the eval delta says so - recorded in the
 * 0006 checklist under B1.
 * Tools re-pinned 2026-11-02 for B7, 857 -> 961: edit_file's `edits` list (several changes in one
 * call, all or nothing). One multi-edit call saves more than that against separate calls, each
 * re-reading its result.
 * Tools re-pinned 2026-11-02 for B21/B22, 961 -> 1122: run_shell timeout_ms and background, and the
 * job_output tool - without them a dev server or a build longer than a minute cannot be run at all.
 * Tools re-pinned 2026-11-02 for C7, 1122 -> 1242: ask_user, so a model that needs a decision asks
 * once instead of guessing or stopping the turn.
 * Tools re-pinned 2026-11-02 for G2, 1242 -> 1309: the skill tool, so the model can load a listed
 * skill (review, security-review, commit, and the user's own) instead of improvising the job.
 */
const PINNED = { system: { default: 519, qwen: 756, small: 119 } as Record<PromptProfile, number>, tools: 1309 };
const TOLERANCE = 0.05;
const ALL_TOOLS = [...defaultTools.map((t) => t.name), 'code_graph'];

function within(actual: number, pinned: number): boolean {
  return actual <= pinned * (1 + TOLERANCE);
}

test('the system prompt (per profile) and built-in tool schemas stay within 5% of their pinned size', () => {
  for (const profile of ['default', 'qwen', 'small'] as const) {
    const system = estimateTextTokens(buildSystemPrompt({ profile, tools: ALL_TOOLS, environment: [] }));
    assert.ok(within(system, PINNED.system[profile]), `${profile} system prompt is ${system} tokens, pinned ${PINNED.system[profile]} - update the pin deliberately if this growth is intended`);
  }
  const tools = estimateTextTokens(
    JSON.stringify(defaultTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))),
  );
  assert.ok(within(tools, PINNED.tools), `tool schemas are ${tools} tokens, pinned ${PINNED.tools} - update the pin deliberately if this growth is intended`);
});

test('profile: config wins, else Qwen by name, under-10B models get the short prompt', () => {
  assert.equal(promptProfileFor('Qwen3.8-27B-Q4_K_M.gguf'), 'qwen');
  assert.equal(promptProfileFor('qwen3-8b-instruct'), 'small');
  assert.equal(promptProfileFor('llama-3.2-3B'), 'small');
  assert.equal(promptProfileFor('gemma-2-27b'), 'default');
  assert.equal(promptProfileFor('claude-opus-5'), 'default');
  assert.equal(promptProfileFor(undefined), 'default');
  assert.equal(promptProfileFor('Qwen3.8-27B', 'small'), 'small');
  assert.equal(promptProfileFor('Qwen3.8-27B', 'nonsense'), 'qwen');
});

test('lines and the example naming a tool the session lacks are left out', () => {
  const text = (tools: string[], profile: PromptProfile = 'qwen') => buildSystemPrompt({ profile, tools, environment: [] });
  const all = text(ALL_TOOLS);
  assert.match(all, /code_graph/);
  assert.match(all, /<function=edit_file>/);
  const noGraph = text(ALL_TOOLS.filter((t) => t !== 'code_graph'));
  assert.doesNotMatch(noGraph, /code_graph/);
  const readOnly = text(['read_file', 'grep_files', 'glob_files']);
  assert.doesNotMatch(readOnly, /edit_file|write_file|run_shell|# Example/);
  assert.match(readOnly, /Look at the project with read_file/);
});

test('sections: fixed order, environment and O4C.md last, and the same input gives the same bytes', () => {
  const input = { profile: 'qwen' as const, tools: ALL_TOOLS, environment: ['Working directory: C:\\p', 'Platform: Windows.'], projectContext: '# O4C.md\nuse tabs' };
  assert.deepEqual(
    promptSections(input).map((s) => s.name),
    ['identity', 'rules', 'workflow', 'tools', 'reporting', 'example', 'environment', 'project'],
  );
  assert.equal(buildSystemPrompt(input), buildSystemPrompt({ ...input, tools: [...ALL_TOOLS] }));
  assert.ok(buildSystemPrompt(input).endsWith('# O4C.md\nuse tabs'));
  assert.deepEqual(
    promptSections({ ...input, profile: 'small' }).map((s) => s.name),
    ['identity', 'rules', 'environment', 'project'],
  );
});
