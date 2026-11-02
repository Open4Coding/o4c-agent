import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SYSTEM_PROMPT } from '../agent/systemPrompt.js';
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
 */
const PINNED = { system: 70, tools: 857 };
const TOLERANCE = 0.05;

function within(actual: number, pinned: number): boolean {
  return actual <= pinned * (1 + TOLERANCE);
}

test('the system prompt and built-in tool schemas stay within 5% of their pinned size', () => {
  const system = estimateTextTokens(SYSTEM_PROMPT);
  const tools = estimateTextTokens(
    JSON.stringify(defaultTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))),
  );
  assert.ok(within(system, PINNED.system), `system prompt is ${system} tokens, pinned ${PINNED.system} - update the pin deliberately if this growth is intended`);
  assert.ok(within(tools, PINNED.tools), `tool schemas are ${tools} tokens, pinned ${PINNED.tools} - update the pin deliberately if this growth is intended`);
});
