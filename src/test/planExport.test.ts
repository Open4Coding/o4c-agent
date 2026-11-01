import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { checklistMarkdown, exportPlan, fileSafeName, planMarkdown } from '../session/planExport.js';
import { importPlanFiles } from '../session/planImport.js';

/** Brief 0005, Q1 / checklist P9: export as a snapshot, never imported back. */

test('fileSafeName: one word for the NNNN.Name convention', () => {
  assert.equal(fileSafeName('Export Plans: v2!'), 'ExportPlansV2');
  assert.equal(fileSafeName('   '), 'Plan');
});

test('the markdown: plan text and a checklist with status, checks, verification and notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-planexport-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    const plans = store.plans();
    const plan = plans.createPlan({
      name: 'Export',
      goal: 'files',
      summary: 'Two files.',
      body: 'The body.',
      items: [{ text: 'a', checks: 'c1' }, { text: 'b' }, { text: 'c' }, { text: 'd' }],
    });
    plans.setItemStatus(plan.id, 1, 'done', { verification: 'ran\nit', note: 'easy' });
    plans.setItemStatus(plan.id, 2, 'doing');
    plans.setItemStatus(plan.id, 3, 'skipped');
    const when = new Date('2026-11-01T12:00:00Z');
    assert.equal(
      planMarkdown(plan, when),
      '# 0001. Export\n\n_Exported from o4c 2026-11-01. A snapshot: the plan lives in o4c (/view-plan), and editing this file changes nothing there._\n\n**Goal:** files\n\n**Summary:** Two files.\n\nThe body.\n',
    );
    assert.equal(
      checklistMarkdown(plans, plan, when).split('\n').slice(4).join('\n'),
      ['- [x] 1. a', '  - c1', '      Verified: ran it', '      Note: easy', '- [ ] 2. b (in progress)', '- [-] 3. c (skipped)', '- [ ] 4. d', ''].join('\n'),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exportPlan writes both files, records the stem, and the startup import then leaves them alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o4c-planexport-root-'));
  const store = new InfiniteContextStore(join(root, '.o4c', 'db', INFINITE_CONTEXT_DB_FILENAME));
  try {
    const plans = store.plans();
    const plan = plans.createPlan({ name: 'Export Plans', items: [{ text: 'one' }] });
    const files = await exportPlan(root, plans, plan);
    assert.equal(files.planFile, join(root, '.o4c', 'plans', '0001.ExportPlans.plan.md'));
    assert.match(await readFile(files.checklistFile, 'utf-8'), /- \[ \] 1\. one/);
    assert.equal(plans.getPlan(plan.id)!.source_file, '0001.ExportPlans');

    const imported = await importPlanFiles(root, plans);
    assert.deepEqual(imported.imported, [], 'its own export is not imported as a second plan');
    assert.equal(plans.listPlans().length, 1);

    plans.updatePlan(plan.id, { name: 'Renamed' });
    const again = await exportPlan(root, plans, plans.getPlan(plan.id)!);
    assert.equal(again.planFile, files.planFile, 'a later export overwrites the same files');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
