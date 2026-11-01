import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { PlanRuleError, formatPlanNo, type PlanStore } from '../session/planStore.js';

/** Brief 0005, checklist P1: plans and their checklists live in `history.db`. */

async function withPlans(fn: (plans: PlanStore, store: InfiniteContextStore) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-plans-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    fn(store.plans(), store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const positions = (plans: PlanStore, planId: number) => plans.items(planId).map((i) => `${i.position}:${i.text}`);

test('a plan is created with numbered items, numbers count up, and an imported number is kept', async () => {
  await withPlans((plans) => {
    const first = plans.createPlan({ name: 'Plans in SQLite', goal: 'store plans', items: [{ text: ' store ' }, { text: 'tool', checks: 'a\nb' }] });
    assert.equal(first.number, 1);
    assert.equal(first.kind, 'plan');
    assert.equal(first.status, 'open');
    assert.deepEqual(positions(plans, first.id), ['1:store', '2:tool']);
    assert.equal(plans.getItem(first.id, 2)!.checks, 'a\nb');

    assert.equal(plans.createPlan({ name: 'Imported', number: 7, source_file: '0007.Imported.plan.md' }).number, 7);
    assert.equal(plans.createPlan({ name: 'Next' }).number, 8);
    assert.equal(plans.getPlanBySourceFile('0007.Imported.plan.md')!.name, 'Imported');
    assert.throws(() => plans.createPlan({ name: 'Clash', number: 7 }), PlanRuleError);
    assert.equal(formatPlanNo(7), '0007');
  });
});

test('items: add anywhere, remove, move both ways - positions stay dense', async () => {
  await withPlans((plans) => {
    const { id } = plans.createPlan({ name: 'p', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    assert.equal(plans.addItem(id, { text: 'first' }, 0), 1);
    assert.equal(plans.addItem(id, { text: 'after-b' }, 3), 4);
    assert.equal(plans.addItem(id, { text: 'last' }), 6);
    assert.deepEqual(positions(plans, id), ['1:first', '2:a', '3:b', '4:after-b', '5:c', '6:last']);

    plans.removeItem(id, 1);
    assert.deepEqual(positions(plans, id), ['1:a', '2:b', '3:after-b', '4:c', '5:last']);
    plans.moveItem(id, 1, 4);
    assert.deepEqual(positions(plans, id), ['1:b', '2:after-b', '3:c', '4:a', '5:last']);
    plans.moveItem(id, 5, 1);
    assert.deepEqual(positions(plans, id), ['1:last', '2:b', '3:after-b', '4:c', '5:a']);
    plans.moveItem(id, 2, 99);
    assert.deepEqual(positions(plans, id), ['1:last', '2:after-b', '3:c', '4:a', '5:b'], 'past the end clamps to last');

    plans.rewordItem(id, 1, 'renamed', 'check one');
    assert.equal(plans.getItem(id, 1)!.text, 'renamed');
    assert.equal(plans.getItem(id, 1)!.checks, 'check one');
    assert.throws(() => plans.rewordItem(id, 1, '  '), PlanRuleError);
    assert.throws(() => plans.removeItem(id, 9), /no item 9; the plan has 5 items/);
  });
});

test('done needs a verification note; doing is exclusive; the current item follows status', async () => {
  await withPlans((plans) => {
    const { id } = plans.createPlan({ name: 'p', items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    assert.equal(plans.currentItem(id)!.position, 1, 'nothing started: the first open item');

    assert.throws(() => plans.setItemStatus(id, 1, 'done'), /without a verification note/);
    assert.equal(plans.getItem(id, 1)!.status, 'open', 'a refused change changes nothing');

    plans.setItemStatus(id, 2, 'doing');
    assert.equal(plans.currentItem(id)!.position, 2, 'a doing item is current even when an earlier one is open');
    plans.setItemStatus(id, 3, 'doing');
    assert.equal(plans.getItem(id, 2)!.status, 'open', 'only one item is doing at a time');

    plans.setItemStatus(id, 3, 'done', { verification: 'npm test: 12/12', note: 'took two tries' }, 1000);
    const done = plans.getItem(id, 3)!;
    assert.equal(done.status, 'done');
    assert.equal(done.verification, 'npm test: 12/12');
    assert.equal(done.notes, 'took two tries');
    assert.equal(done.done_at, 1000);

    plans.addItemNote(id, 1, 'checked the docs');
    plans.setItemStatus(id, 1, 'skipped');
    plans.setItemStatus(id, 2, 'done', { verification: 'ran it' });
    assert.equal(plans.currentItem(id), undefined, 'all finished: no current item');

    plans.setItemStatus(id, 3, 'open');
    assert.equal(plans.getItem(id, 3)!.done_at, null, 'reopening clears done_at');
    plans.setItemStatus(id, 3, 'done');
    assert.equal(plans.getItem(id, 3)!.status, 'done', 'a verification already on the item counts');
  });
});

test('one active plan per session; activating another parks the first', async () => {
  await withPlans((plans) => {
    const a = plans.createPlan({ name: 'a' });
    const b = plans.createPlan({ name: 'b' });
    plans.activate(a.id, 's1');
    plans.activate(b.id, 's2');
    assert.equal(plans.activePlan('s1')!.id, a.id);
    plans.activate(b.id, 's1');
    assert.equal(plans.activePlan('s1')!.id, b.id);
    assert.equal(plans.getPlan(a.id)!.active_session, null);
    assert.equal(plans.activePlan('s2'), undefined, 'a plan is active in one session at a time');
    plans.park(b.id);
    assert.equal(plans.activePlan('s1'), undefined);
  });
});

test('plans are searchable, edits re-index, task links are kept, the list is newest first', async () => {
  await withPlans((plans) => {
    const a = plans.createPlan({ name: 'Export', summary: 'write markdown snapshots' }, 1);
    const b = plans.createPlan({ name: 'Picker', body: 'dropdown of plans' }, 2);
    assert.deepEqual(plans.searchPlans('"markdown"').map((p) => p.id), [a.id]);
    plans.updatePlan(b.id, { summary: 'markdown too' }, 3);
    assert.deepEqual(plans.searchPlans('"markdown"').map((p) => p.id).sort(), [a.id, b.id].sort());
    assert.deepEqual(plans.listPlans().map((p) => p.name), ['Picker', 'Export']);

    plans.createPlan({ name: 'x', items: [{ text: 'one' }] });
    const x = plans.getPlanByNumber(3)!;
    plans.linkTask(x.id, 1, 42);
    plans.linkTask(x.id, 1, 42);
    plans.linkTask(x.id, 1, 7);
    assert.deepEqual(plans.itemTasks(plans.getItem(x.id, 1)!.id), [7, 42]);
  });
});
