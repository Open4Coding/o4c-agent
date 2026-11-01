import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { parsePlanEditCommand, planActionRows, planItemOpRows, planItemRows, planPickerRows } from '../ui/planPicker.js';

/** Brief 0005, checklist P7/P10: `/view-plan`'s dropdown rows, and the edit commands they hand to the input box. */

test('plan rows, action rows (park only for the active plan) and item rows with their marks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-planpicker-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    const plans = store.plans();
    const plan = plans.createPlan({ name: 'Export', summary: 'Two\nfiles.', items: [{ text: 'a' }, { text: 'b\nmore' }] });
    plans.setItemStatus(plan.id, 1, 'done', { verification: 'ok' });
    assert.deepEqual(planPickerRows(plans), [{ key: String(plan.id), label: '0001 Export - open, 1 of 2 items finished - Two files.' }]);

    assert.deepEqual(planActionRows(plan, 's1').map((r) => r.key), ['view', 'full', 'activate', 'edit', 'export']);
    plans.activate(plan.id, 's1');
    assert.deepEqual(planActionRows(plans.getPlan(plan.id)!, 's1').map((r) => r.key), ['view', 'full', 'park', 'edit', 'export']);

    assert.deepEqual(planItemRows(plans, plan), [
      { key: '1', label: '[x] 1. a' },
      { key: '2', label: '[ ] 2. b more' },
      { key: 'end', label: '+ Add an item at the end' },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('item operations leave out the moves that cannot happen', () => {
  assert.deepEqual(planItemOpRows(1, 3).map((r) => r.key), ['reword', 'down', 'remove', 'add']);
  assert.deepEqual(planItemOpRows(3, 3).map((r) => r.key), ['reword', 'up', 'remove', 'add']);
  assert.deepEqual(planItemOpRows(1, 1).map((r) => r.key), ['reword', 'remove', 'add']);
});

test('parsePlanEditCommand: the two hidden commands, with their text; anything else is not one', () => {
  assert.deepEqual(parsePlanEditCommand('/plan-reword 5 2  new words '), { op: 'reword', plan: 5, item: 2, text: 'new words' });
  assert.deepEqual(parsePlanEditCommand('/plan-add 5 0 first'), { op: 'add', plan: 5, item: 0, text: 'first' });
  assert.deepEqual(parsePlanEditCommand('/plan-add 5 3'), { op: 'add', plan: 5, item: 3, text: '' });
  assert.equal(parsePlanEditCommand('/plan-add five 3 x'), undefined);
  assert.equal(parsePlanEditCommand('/plan reword'), undefined);
});
