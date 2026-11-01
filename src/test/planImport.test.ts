import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { importPlanFiles, parseChecklist, summaryOf } from '../session/planImport.js';

/** Brief 0005, Q2 / checklist P2: existing `.o4c/plans/*.md` files are imported once. */

async function withProject(fn: (ctx: { root: string; plansDir: string; store: InfiniteContextStore }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'o4c-planimport-test-'));
  const plansDir = join(root, '.o4c', 'plans');
  await mkdir(plansDir, { recursive: true });
  const store = new InfiniteContextStore(join(root, '.o4c', 'db', INFINITE_CONTEXT_DB_FILENAME));
  try {
    await fn({ root, plansDir, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('parseChecklist: top-level boxes are items, indented boxes are checks, indented prose continues the item', () => {
  const items = parseChecklist(
    [
      '# Checklist',
      '',
      'Some intro prose.',
      '- [x] P1. Store',
      '      tables in history.db',
      '- [ ] P2. Import',
      '  - [ ] reads files',
      '  * [X] reports misnamed ones',
      '',
      '* [ ] P3. Tool',
    ].join('\r\n'),
  );
  assert.deepEqual(items, [
    { text: 'P1. Store\ntables in history.db', checks: '', done: true },
    { text: 'P2. Import', checks: 'reads files\nreports misnamed ones', done: false },
    { text: 'P3. Tool', checks: '', done: false },
  ]);
  assert.deepEqual(parseChecklist('no items here\n  - [ ] orphan check'), [], 'a check before any item belongs to nothing');
});

test('summaryOf: the first paragraph that is not a heading, flattened', () => {
  assert.equal(summaryOf('# Title\n\n## Sub\n\nThe plan\nin two lines.\n\nMore.'), 'The plan in two lines.');
  assert.equal(summaryOf('# Title\nGlued to its heading.'), 'Glued to its heading.');
  assert.equal(summaryOf('# Only a heading'), '');
  assert.ok(summaryOf('x'.repeat(2000)).endsWith('...'));
});

test('import: plans come in with their numbers, done items verified as imported, and only once', async () => {
  await withProject(async ({ root, plansDir, store }) => {
    await writeFile(join(plansDir, '0003.Export.plan.md'), '# Export\n\nWrite markdown snapshots.\n');
    await writeFile(join(plansDir, '0003.Export.checklist.md'), '- [x] write plan.md\n- [ ] write checklist.md\n');
    await writeFile(join(plansDir, '0004.OnlyChecklist.checklist.md'), '- [ ] one\n');
    await writeFile(join(plansDir, 'notes.txt'), 'not a plan');
    const plans = store.plans();

    const first = await importPlanFiles(root, plans);
    assert.deepEqual(first.imported, ['0003.Export', '0004.OnlyChecklist']);
    assert.deepEqual(first.unrecognised, ['notes.txt']);

    const exp = plans.getPlanByNumber(3)!;
    assert.equal(exp.name, 'Export');
    assert.equal(exp.summary, 'Write markdown snapshots.');
    assert.match(exp.body, /# Export/);
    const items = plans.items(exp.id);
    assert.deepEqual(items.map((i) => [i.text, i.status]), [['write plan.md', 'done'], ['write checklist.md', 'open']]);
    assert.equal(items[0].verification, 'Imported as done from 0003.Export.checklist.md');
    assert.equal(plans.getPlanByNumber(4)!.body, '', 'no .plan.md: an empty body, not a failure');

    await writeFile(join(plansDir, '0003.Export.checklist.md'), '- [x] edited after import\n');
    const again = await importPlanFiles(root, plans);
    assert.deepEqual(again.imported, [], 'already imported: nothing new, and an edited export does not flow back');
    assert.equal(plans.items(exp.id)[0].text, 'write plan.md');
  });
});

test('import: a number already taken in the store is renumbered and reported', async () => {
  await withProject(async ({ root, plansDir, store }) => {
    const plans = store.plans();
    plans.createPlan({ name: 'Made in o4c' });
    await writeFile(join(plansDir, '0001.FromDisk.plan.md'), 'body');
    const result = await importPlanFiles(root, plans);
    assert.deepEqual(result.renumbered, ['0001.FromDisk -> 0002']);
    assert.equal(plans.getPlanByNumber(2)!.name, 'FromDisk');
  });
});

test('import: no project or no plans directory imports nothing and never throws', async () => {
  await withProject(async ({ store }) => {
    assert.deepEqual(await importPlanFiles(undefined, store.plans()), { imported: [], renumbered: [], unrecognised: [] });
    const empty = await mkdtemp(join(tmpdir(), 'o4c-planimport-empty-'));
    try {
      assert.deepEqual((await importPlanFiles(empty, store.plans())).imported, []);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
