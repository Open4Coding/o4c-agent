import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { PLAN_BLOCK_CHARS, planBlock, planContextComponent } from '../session/planContext.js';
import type { PlanStore } from '../session/planStore.js';
import { aiResponseEntry, userInputEntry, type ContextEntry } from '../agent/contextEntry.js';

/** Brief 0005, Q7 / checklist P8: the active plan's current item rides along with every request. */

async function withPlans(fn: (plans: PlanStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-plancontext-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    await fn(store.plans());
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('planBlock: name, progress, the current item with its checks, the one-item rule; nothing without an active plan', async () => {
  await withPlans(async (plans) => {
    const plan = plans.createPlan({ name: 'Export', items: [{ text: 'plan.md' }, { text: 'checklist.md', checks: 'all items\nmarks' }] });
    assert.equal(planBlock(plans, 's1'), undefined, 'not active');
    plans.activate(plan.id, 's1');
    plans.setItemStatus(plan.id, 1, 'done', { verification: 'opened it' });
    plans.setItemStatus(plan.id, 2, 'doing');
    assert.equal(
      planBlock(plans, 's1'),
      [
        '[o4c plan] Active plan 0001 "Export" - 1 of 2 items finished.',
        'Current item 2 (in progress): checklist.md',
        '  - all items',
        '  - marks',
        'Work on this item only. Use update_plan to start it, and to mark it done with how you verified it.',
      ].join('\n'),
    );
    plans.setItemStatus(plan.id, 2, 'done', { verification: 'ok' });
    assert.match(planBlock(plans, 's1')!, /Every item is finished\./);
    plans.addItem(plan.id, { text: 'x'.repeat(5000) });
    assert.equal(planBlock(plans, 's1')!.length, PLAN_BLOCK_CHARS, 'capped');
  });
});

test('the component folds the block into the current message only, and stays out for none and before a new message', async () => {
  await withPlans(async (plans) => {
    const plan = plans.createPlan({ name: 'P', items: [{ text: 'step one' }] });
    plans.activate(plan.id, 's1');
    let enabled = true;
    const component = planContextComponent({ plans, sessionId: 's1', enabled: () => enabled });
    const entries: ContextEntry[] = [userInputEntry('earlier'), aiResponseEntry('ok'), userInputEntry('now'), aiResponseEntry('working')];

    const built = await component.buildRequest!({ entries });
    assert.equal(built[0].content, 'earlier');
    assert.match(built[2].content, /^now\n\n\[o4c plan\] Active plan 0001 "P"/);
    assert.equal(entries[2].content, 'now', 'history itself is never changed');

    assert.equal(await component.buildRequest!({ entries, beforeNewMessage: true }), entries);
    enabled = false;
    assert.equal(await component.buildRequest!({ entries }), entries);
    enabled = true;
    plans.park(plan.id);
    assert.equal(await component.buildRequest!({ entries }), entries);
  });
});
