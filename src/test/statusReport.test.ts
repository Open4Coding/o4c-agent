import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus } from '../ui/statusReport.js';

/** Plan 0006 E2: /status on one screen. */

test('every part of the setup is on its own line, with the command that changes it', () => {
  const text = formatStatus({
    model: 'Qwen3.8-27B', provider: 'local', contextWindow: 229376, contextUsed: 45875, cachePercent: 93, lastPrefillMs: 1200,
    draftAcceptPercent: 71, lastCacheBreak: 'cache break: tools changed', instructionFiles: ['AGENTS.md'], promptProfile: 'qwen',
    thinkLevel: 'med', sampling: 'temperature 1, top_p 0.95', shell: 'cmd (cmd.exe)', mcp: ['github: connected, 12 tools'],
    checkpoints: true, memories: 3, permissionRules: 0,
  }).join('\n');
  assert.match(text, /Model: +Qwen3\.8-27B via local/);
  assert.match(text, /Context: +~45,875 tokens of 229,376 \(20%\)/);
  assert.match(text, /Cache: +93% of prompt tokens served from cache this session; last prefill 1\.2 s/);
  assert.match(text, /Drafting: +71% of drafted tokens accepted/);
  assert.match(text, /Instructions: AGENTS\.md/);
  assert.match(text, /Prompt: +profile qwen \(\/view-prompt\)/);
  assert.match(text, /Shell: +cmd \(cmd\.exe\) \(\/set-shell\)/);
  assert.match(text, /Checkpoints: +on/);
  assert.match(text, /Permissions: +no rules - modes decide/);
  const bare = formatStatus({ model: 'm', provider: 'mock', contextUsed: 10, instructionFiles: [], thinkLevel: 'off', sampling: 'server defaults', shell: 'sh', mcp: [], checkpoints: false, memories: 0, permissionRules: 2 }).join('\n');
  assert.match(bare, /window size unknown/);
  assert.match(bare, /Instructions: none \(o4c\.md, AGENTS\.md or CLAUDE\.md - \/init writes one\)/);
  assert.doesNotMatch(bare, /Drafting/);
});
