import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { createPlanTool } from '../session/planTool.js';
import type { PlanStore } from '../session/planStore.js';
import type { Tool } from '../tools/types.js';

/** Brief 0005, checklist P3: `update_plan`, the model's side of a plan. */

async function withTool(fn: (ctx: { plans: PlanStore; tool: Tool; task: { id: number | undefined } }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-plantool-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  const task = { id: undefined as number | undefined };
  const plans = store.plans();
  try {
    await fn({ plans, tool: createPlanTool({ plans, sessionId: 's1', currentTask: () => task.id }), task });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('show: header, summary, the checklist last, the current item\'s checks below it', async () => {
  await withTool(async ({ plans, tool }) => {
    plans.createPlan({
      name: 'Export',
      goal: 'write md files',
      summary: 'Snapshots only.',
      items: [{ text: 'plan.md' }, { text: 'checklist.md', checks: 'all items\nstatus marks' }],
    });
    plans.setItemStatus(1, 1, 'done', { verification: 'opened the file' });
    const out = await tool.execute({ action: 'show' });
    assert.equal(
      out,
      [
        'Plan 0001 Export - open, 1 of 2 items finished',
        'Goal: write md files',
        '',
        'Snapshots only.',
        '',
        'Checklist:',
        '[x] 1. plan.md',
        '[ ] 2. checklist.md',
        '',
        'Current: item 2 of 2 - checklist.md',
        '  - all items',
        '  - status marks',
      ].join('\n'),
    );
  });
});

test('start, done with verification, and the refusal without one - as text the model can act on', async () => {
  await withTool(async ({ plans, tool, task }) => {
    const { id } = plans.createPlan({ name: 'p', items: [{ text: 'a' }, { text: 'b' }] });
    task.id = 41;
    assert.match(await tool.execute({ action: 'start', item: 1 }), /^Item 1 is now doing\./);
    assert.match(await tool.execute({ action: 'done', item: 1 }), /cannot be marked done without a verification note/);
    const done = await tool.execute({ action: 'done', item: 1, verification: 'npm test 3/3', note: 'easy' });
    assert.match(done, /Item 1 is now done\./);
    assert.match(done, /Current: item 2 of 2 - b/);
    assert.deepEqual(plans.itemTasks(plans.getItem(id, 1)!.id), [41], 'the running task is linked');
    assert.match(await tool.execute({ action: 'start' }), /needs "item"/);
    assert.match(await tool.execute({ action: 'skip', item: 9 }), /no item 9; the plan has 2 items/);
  });
});

test('add, move, reword, remove, note', async () => {
  await withTool(async ({ plans, tool }) => {
    const { id } = plans.createPlan({ name: 'p', items: [{ text: 'a' }, { text: 'b' }] });
    assert.match(await tool.execute({ action: 'add', text: 'first', after: 0 }), /Added as item 1\./);
    await tool.execute({ action: 'move', item: 1, to: 3 });
    await tool.execute({ action: 'reword', item: 1, text: 'A' });
    await tool.execute({ action: 'remove', item: 2 });
    assert.deepEqual(plans.items(id).map((i) => i.text), ['A', 'first']);
    assert.equal(await tool.execute({ action: 'note', item: 2, note: 'keep' }), 'Noted on item 2.');
    assert.match(await tool.execute({ action: 'add' }), /needs "text"/);
    assert.match(await tool.execute({ action: 'fly' }), /Unknown action "fly"/);
  });
});

test('which plan: named, else active, else the only open one, else a list to choose from', async () => {
  await withTool(async ({ plans, tool }) => {
    assert.equal(await tool.execute({ action: 'show' }), 'No plan is active. There are no plans yet.');
    const a = plans.createPlan({ name: 'Alpha' });
    assert.match(await tool.execute({ action: 'show' }), /^Plan 0001 Alpha/, 'the only open plan');
    plans.createPlan({ name: 'Beta' });
    assert.equal(await tool.execute({ action: 'show' }), 'No plan is active. Name one with "plan": 2 (Beta), 1 (Alpha).');
    plans.activate(a.id, 's1');
    assert.match(await tool.execute({ action: 'show' }), /^Plan 0001 Alpha - open, active/);
    assert.match(await tool.execute({ action: 'show', plan: 2 }), /^Plan 0002 Beta/);
    assert.match(await tool.execute({ action: 'show', plan: 9 }), /^There is no plan 0009\./);
  });
});
