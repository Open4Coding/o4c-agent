import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { HistoryRetrieval } from '../session/retrieval.js';
import { gatherUltraplanResearch, identifiersIn } from '../session/ultraplanResearch.js';

/** Brief 0005, Q6 / checklist P6: `/ultraplan`'s fixed research steps, done by o4c. */

test('identifiersIn: code-looking names only', () => {
  assert.deepEqual(identifiersIn('add exportPlan to plan_store and planView.ts for the picker'), ['exportPlan', 'plan_store', 'planView.ts']);
});

test('research: matching past tasks opened, the graph focused on the goal\'s names and those tasks\' files, the search logged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-ultraplan-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    store.ensureSession({ id: 's1', title: 't', started_at: 1 });
    const task = store.startTask({ session_id: 's1', request: 'write the markdown export for plans' });
    store.setTaskAnswer(task.id, 'exportPlan writes two files');
    store.addTaskFile(task.id, 'src/session/planExport.ts');
    store.finishTask(task.id);
    const retrieval = new HistoryRetrieval({ store, sessionId: 's1', currentTask: () => undefined, entityExists: () => undefined });

    let focus: { idents: string[]; files: string[] } | undefined;
    const text = gatherUltraplanResearch('change the markdown export in exportPlan', {
      store,
      retrieval,
      graphMap: (f) => ((focus = f), 'src/session/planExport.ts:\n  exportPlan'),
    });
    assert.match(text, /^Past tasks \(1 best matches, opened\):\n#\d+ write the markdown export for plans/);
    assert.match(text, /Answer: exportPlan writes two files/);
    assert.match(text, /Code Graph - the files and definitions that rank highest for this goal:\nsrc\/session\/planExport.ts:/);
    assert.deepEqual(focus, { idents: ['exportPlan'], files: ['src/session/planExport.ts'] });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('research: a missing source is said, not skipped', () => {
  const text = gatherUltraplanResearch('anything', {});
  assert.equal(text, 'Past tasks: no history store in this project.\nCode Graph: not available (off, or still indexing).');
});
