import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { parsePlanAnswer, parsePlanCommand, planPrompt, savePlanFromAnswer, type PlanHooks } from '../session/planAuthoring.js';

/** Brief 0005, checklist P5: `/plan <goal>` -> a planning turn -> a saved, active plan. */

const ANSWER = [
  'I looked at the session code first.',
  '',
  '# Plan Export',
  '',
  'Summary: Write each plan out as two markdown files.',
  '',
  '## Plan',
  'Add exportPlan() in src/session/planExport.ts.',
  '',
  '## Checklist',
  '- [ ] Write exportPlan',
  '  - [ ] unit test passes',
  '- [ ] Add the picker action',
  '  - [ ] App test shows the files',
].join('\n');

test('parsePlanCommand: /plan and /ultraplan with their goal; anything else is not one', () => {
  assert.deepEqual(parsePlanCommand('/plan  add export '), { kind: 'plan', goal: 'add export' });
  assert.deepEqual(parsePlanCommand('/ultraplan rework\nthe picker'), { kind: 'ultraplan', goal: 'rework\nthe picker' });
  assert.deepEqual(parsePlanCommand('/plan'), { kind: 'plan', goal: '' });
  assert.equal(parsePlanCommand('/plans'), undefined);
  assert.equal(parsePlanCommand('plan this'), undefined);
});

test('planPrompt: the first line is the user\'s command (the task title), then the instruction and the answer shape', () => {
  const prompt = planPrompt({ kind: 'plan', goal: 'add export' });
  assert.equal(prompt.split('\n')[0], '/plan add export');
  assert.match(prompt, /do not change anything/);
  assert.match(prompt, /## Checklist/);
  assert.match(planPrompt({ kind: 'ultraplan', goal: 'g' }, 'past task #3: export'), /--- gathered by o4c ---\npast task #3: export\n--- end ---/);
});

test('parsePlanAnswer: name, summary, plan body and checklist items with their checks', () => {
  assert.deepEqual(parsePlanAnswer(ANSWER), {
    name: 'Plan Export',
    summary: 'Write each plan out as two markdown files.',
    body: 'Add exportPlan() in src/session/planExport.ts.',
    items: [
      { text: 'Write exportPlan', checks: 'unit test passes' },
      { text: 'Add the picker action', checks: 'App test shows the files' },
    ],
  });
  const drifted = parsePlanAnswer('### Checklist:\n- [ ] only step\n');
  assert.ok(!('error' in drifted));
  assert.equal(drifted.name, 'Untitled plan');
  assert.match((parsePlanAnswer('# Name\n\nJust prose, no steps.') as { error: string }).error, /no "## Checklist"/);
});

test('savePlanFromAnswer: saved with the goal, made active, tool re-offered; a bad answer saves nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-planauthoring-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    let changed = 0;
    const hooks: PlanHooks = { store: store.plans(), sessionId: 's1', changed: () => changed++, currentTask: () => 12 };
    const saved = savePlanFromAnswer(hooks, { kind: 'plan', goal: 'add export' }, ANSWER);
    assert.equal(saved.message, 'Saved as plan 0001 "Plan Export" (2 items), now the active plan. See it with /view-plan; ask o4c to start on it when you are ready.');
    const plan = hooks.store.activePlan('s1')!;
    assert.equal(plan.goal, 'add export');
    assert.equal(plan.task_id, 12);
    assert.equal(changed, 1);

    const bad = savePlanFromAnswer(hooks, { kind: 'ultraplan', goal: 'x' }, 'no checklist here');
    assert.equal(bad.plan, undefined);
    assert.match(bad.message, /nothing to save as a plan\. Ask again, or run \/ultraplan with a clearer goal\./);
    assert.equal(hooks.store.listPlans().length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
