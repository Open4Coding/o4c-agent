import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraphStore, GRAPH_DB_FILENAME } from '../graph/graphStore.js';
import { createWorkerPass, runIndexPassInProcess } from '../graph/indexPass.js';
import { fromResponse, toResponse } from '../graph/indexWorker.js';
import { indexProject, indexSource } from '../graph/indexer.js';
import { CodeGraphComponent } from '../graph/toolHook.js';

/**
 * Indexing in a worker.
 *
 * The point of the worker is measured and recorded in `indexWorker.ts`: on a 5,893-file
 * repository a full pass blocked the main thread for 27.7 s in total with a worst stall of
 * 416 ms. What is worth *testing* is not the speed - a timing assertion would be flaky and would
 * not say anything about correctness - but the three things that make it safe to have a second
 * writer:
 *
 * 1. the worker really starts, in both the way o4c runs under `tsx` and the way it ships;
 * 2. a worker that cannot start is a slow session, not a broken one;
 * 3. a file indexed on the main thread *while* a pass is running is not swept away by it.
 */

interface Fixture {
  readonly root: string;
  readonly dir: string;
  readonly store: GraphStore;
}

async function withProject(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-indexworker-'));
  const root = join(dir, 'project');
  await mkdir(root, { recursive: true });
  const store = new GraphStore(join(dir, GRAPH_DB_FILENAME));
  try {
    await fn({ root, dir, store });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const AREA = 'export function computeArea(r: number): number { return r * r; }\n';

test('a pass really runs in a worker and the result comes back', async () => {
  await withProject(async ({ root, store }) => {
    await writeFile(join(root, 'area.ts'), AREA);

    let fellBack: string | undefined;
    const pass = createWorkerPass({ onFallback: (reason) => (fellBack = reason) });
    try {
      const run = await pass(store, root);

      // The assertion that matters: the worker path was taken, not the fallback. If the entry
      // file cannot be resolved - the way a packaging change breaks a worker - this is what
      // notices, and a timing test never would.
      assert.equal(fellBack, undefined, `fell back to in-process: ${fellBack}`);
      assert.equal(run.indexed, 1);
      assert.equal(store.definitionsOf('computeArea').length, 1, 'the rows the worker wrote are visible here');
    } finally {
      pass.terminate();
    }
  });
});

test('a worker that cannot start costs startup time and nothing else', async () => {
  await withProject(async ({ root, store }) => {
    await writeFile(join(root, 'area.ts'), AREA);

    let reason: string | undefined;
    const pass = createWorkerPass({
      entry: new URL('./does-not-exist.mjs', import.meta.url),
      onFallback: (r) => (reason = r),
    });
    try {
      const run = await pass(store, root);
      assert.ok(reason, 'the fallback should report why');
      assert.equal(run.indexed, 1, 'the pass still happened, in process');
      assert.equal(store.definitionsOf('computeArea').length, 1);

      // And it does not keep trying: a worker that failed once will fail again, and retrying per
      // pass would pay the spawn and the failure on every file write for the whole session.
      reason = undefined;
      await pass(store, root);
      assert.equal(reason, undefined, 'the second pass went straight to in-process');
    } finally {
      pass.terminate();
    }
  });
});

test('a file indexed during a pass is not swept away by it', async () => {
  await withProject(async ({ root, store }) => {
    await writeFile(join(root, 'area.ts'), AREA);

    // The race the worker introduces: the pass's walk predates a file that `write_file` creates
    // while it runs, so the end-of-pass sweep sees a file it never visited and would drop it.
    //
    // Landed deterministically *inside* the pass through the read seam, which runs once per file.
    // An earlier version of this test indexed the file before starting the pass, which is not the
    // same thing at all - that file really is older than the pass - and it failed for a good
    // reason.
    let injected = false;
    const run = await indexProject(store, root, {
      readSource: async (path) => {
        if (!injected) {
          injected = true;
          await indexSource(store, 'created-mid-pass.ts', 'export function brandNew(): void {}\n');
        }
        return readFile(path, 'utf-8');
      },
    });
    assert.ok(injected, 'the seam has to have fired for this test to mean anything');
    assert.equal(run.indexed, 1, 'the file on disk was indexed');
    assert.equal(
      store.definitionsOf('brandNew').length,
      1,
      'the file indexed during the pass survived the sweep',
    );
  });
});

test('a file that really is gone is still swept', async () => {
  await withProject(async ({ root, store }) => {
    // The other half of the same rule: protecting new rows must not protect stale ones.
    await writeFile(join(root, 'area.ts'), AREA);
    await runIndexPassInProcess(store, root);
    assert.equal(store.definitionsOf('computeArea').length, 1);

    await rm(join(root, 'area.ts'));
    const run = await runIndexPassInProcess(store, root);
    assert.equal(run.removed, 1);
    assert.deepEqual(store.definitionsOf('computeArea'), []);
  });
});

test('the component takes the injected pass runner', async () => {
  await withProject(async ({ root, store }) => {
    await writeFile(join(root, 'area.ts'), AREA);

    let calls = 0;
    const component = new CodeGraphComponent(store, root, (s, r) => {
      calls++;
      return runIndexPassInProcess(s, r);
    });

    await component.reindex();
    assert.equal(calls, 1);
    assert.equal(component.status().phase, 'ready');
  });
});

test('the response survives the worker boundary unchanged', () => {
  // `outcomes` is a Map on both sides and an array in between, because a boundary should have one
  // explicit shape rather than relying on what structured clone happens to support.
  const run = {
    indexed: 3,
    unchanged: 4,
    removed: 1,
    outcomes: new Map([
      ['no-grammar' as const, 7],
      ['failed' as const, 2],
    ]),
    failures: ['a.ts: boom'],
    elapsedMs: 42,
  };
  const round = fromResponse(toResponse(run));
  assert.deepEqual(round, run);
});
