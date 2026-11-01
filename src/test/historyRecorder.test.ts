import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, taskNumber } from '../session/infiniteContextStore.js';
import { HistoryRecorder } from '../session/historyRecorder.js';
import { diffEntities, snapshotEntities, type EntitySnapshot } from '../session/taskEntities.js';
import {
  CONTINUATION_TAG,
  aiResponseEntry,
  aiToolCallResponseEntry,
  userInputEntry,
} from '../agent/contextEntry.js';
import type { Tool } from '../tools/types.js';

/**
 * NextUp item 13, checklist A3/A4: the session is written into the history store as tasks - one
 * exchange each, short follow-ups numbered under the previous task, and every write_file linked
 * to the definitions it changed.
 */

async function withRecorder(
  fn: (ctx: { store: InfiniteContextStore; recorder: HistoryRecorder; root: string; enabled: { on: boolean } }) => Promise<void>,
  sessionId = 's1',
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'o4c-recorder-test-'));
  const store = new InfiniteContextStore(join(root, '.o4c', 'db', 'history.db'));
  const enabled = { on: true };
  const recorder = new HistoryRecorder({ store, sessionId, projectRoot: root, enabled: () => enabled.on });
  try {
    await fn({ store, recorder, root, enabled });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const writeTool = { name: 'write_file' } as Tool;

test('one exchange is one task: request, final answer, errors; the next message closes it', async () => {
  await withRecorder(async ({ store, recorder }) => {
    recorder.onEntry(userInputEntry('create a copy of the game tetris in html'));
    recorder.onEntry(aiResponseEntry('Let me check node first'));
    recorder.onEntry(aiToolCallResponseEntry('c1', 'Command failed: node not found', true));
    recorder.onEntry(aiResponseEntry('Done - tetris.html is written.'));
    const first = store.lastTask('s1')!;
    assert.equal(first.title, 'create a copy of the game tetris in html');
    assert.equal(first.answer, 'Done - tetris.html is written.');
    assert.match(first.errors, /node not found/);
    assert.equal(first.outcome, 'open');

    recorder.onEntry(userInputEntry('now write a README for the tetris game please'));
    assert.equal(store.getTask(first.id)!.outcome, 'done');
    const second = store.lastTask('s1')!;
    assert.notEqual(second.id, first.id);
    assert.equal(second.parent_task_id, null, 'a full message is a new top-level task');
  });
});

test('a short message is a follow-up of the previous task, numbered under it', async () => {
  await withRecorder(async ({ store, recorder }) => {
    recorder.onEntry(userInputEntry('create a copy of the game tetris in html'));
    const root = store.lastTask('s1')!;
    recorder.onEntry(userInputEntry('try again'));
    recorder.onEntry(userInputEntry('make it faster'));
    assert.deepEqual(store.followUps(root.id).map(taskNumber), [`#${root.id}.1`, `#${root.id}.2`]);
  });
});

test('the follow-up rule survives the per-turn reload: a fresh recorder finds the previous task in the store and closes it', async () => {
  await withRecorder(async ({ store, recorder, root }) => {
    recorder.onEntry(userInputEntry('create a copy of the game tetris in html'));
    recorder.onEntry(aiResponseEntry('done'));
    const first = store.lastTask('s1')!;

    const afterReload = new HistoryRecorder({ store, sessionId: 's1', projectRoot: root, enabled: () => true });
    afterReload.onEntry(userInputEntry('try again'));
    assert.equal(store.getTask(first.id)!.outcome, 'done');
    assert.equal(store.lastTask('s1')!.parent_task_id, first.id);
  });
});

test('the loop\'s own "Continue with the task." nudge stays inside the running task', async () => {
  await withRecorder(async ({ store, recorder }) => {
    recorder.onEntry(userInputEntry('create a copy of the game tetris in html'));
    recorder.onEntry({ ...userInputEntry('Continue with the task.'), tags: [CONTINUATION_TAG] });
    recorder.onEntry(aiResponseEntry('finished'));
    const task = store.lastTask('s1')!;
    assert.equal(task.title, 'create a copy of the game tetris in html');
    assert.equal(task.answer, 'finished');
  });
});

test('entries are stored with this session and their task', async () => {
  await withRecorder(async ({ store, recorder }) => {
    const input = userInputEntry('create a copy of the game tetris in html');
    recorder.onEntry(input);
    const row = store.getByUid(input.id)!;
    assert.equal(row.session_id, 's1');
    assert.equal(row.task_id, store.lastTask('s1')!.id);
  });
});

test('recording off (the none type): nothing is written, and an exchange started while off is not continued', async () => {
  await withRecorder(async ({ store, recorder, enabled }) => {
    enabled.on = false;
    const input = userInputEntry('a one-shot question nobody needs kept');
    recorder.onEntry(input);
    recorder.onEntry(aiResponseEntry('answer'));
    assert.equal(store.getByUid(input.id), undefined);
    assert.equal(store.lastTask('s1'), undefined);

    enabled.on = true;
    recorder.onEntry(aiResponseEntry('a late reply from that same exchange'));
    assert.equal(store.lastTask('s1'), undefined, 'no task to file it under');
  });
});

test('write_file: the file is linked to the task, and changed definitions are diffed (modified / added / deleted)', async () => {
  await withRecorder(async ({ store, recorder, root }) => {
    const before = ['export function tryRotate() {', '  return 1;', '}', 'export function oldHelper() {', '  return 0;', '}', ''].join('\n');
    const after = ['export function tryRotate() {', '  return 2;', '}', 'export function newHelper() {', '  return 9;', '}', ''].join('\n');
    await writeFile(join(root, 'game.ts'), before);

    recorder.onEntry(userInputEntry('fix the rotation in game.ts please'));
    const result = await recorder.aroundTool(
      { tool: writeTool, input: { path: 'game.ts', content: after } },
      async () => {
        await writeFile(join(root, 'game.ts'), after);
        return 'Wrote 90 characters to game.ts';
      },
    );
    assert.equal(result, 'Wrote 90 characters to game.ts', 'the tool result is passed through untouched');

    const task = store.lastTask('s1')!;
    assert.equal(store.getTask(task.id)!.files, 'game.ts');
    const changes = Object.fromEntries(
      store.taskEntities(task.id).filter((e) => e.name).map((e) => [e.name, e.change]),
    );
    assert.deepEqual(changes, { tryRotate: 'modified', newHelper: 'added', oldHelper: 'deleted' });
    assert.equal(store.tasksForPath('game.ts')[0].id, task.id);
  });
});

test('write_file of an uncharted language links the file only; a failed write links nothing', async () => {
  await withRecorder(async ({ store, recorder }) => {
    recorder.onEntry(userInputEntry('create a copy of the game tetris in html'));
    await recorder.aroundTool({ tool: writeTool, input: { path: 'tetris.html', content: '<html></html>' } }, async () => 'Wrote 13 characters');
    await recorder.aroundTool({ tool: writeTool, input: { path: 'nope.ts', content: 'x' } }, async () => 'Error writing file "nope.ts": EACCES');
    const rows = store.taskEntities(store.lastTask('s1')!.id);
    assert.deepEqual(rows.map((r) => [r.path, r.change, r.entity_uid]), [['tetris.html', 'written', null]]);
  });
});

test('diffEntities: same body under a new name is a rename, filed under the new identity', () => {
  const a: EntitySnapshot = { uid: 'u-old', name: 'old', kind: 'function', hash: 'H' };
  const b: EntitySnapshot = { uid: 'u-new', name: 'renamed', kind: 'function', hash: 'H' };
  assert.deepEqual(diffEntities([a], [b]), [
    { entity_uid: 'u-new', name: 'renamed', kind: 'function', change: 'renamed', hash_before: 'H', hash_after: 'H' },
  ]);
});

test('snapshotEntities sees a change inside a function body, which the graph\'s declaring-line hash cannot', async () => {
  const one = await snapshotEntities('function f() {\n  return 1;\n}\n', 'a.ts');
  const two = await snapshotEntities('function f() {\n  return 2;\n}\n', 'a.ts');
  assert.ok(one && two);
  assert.equal(one[0].uid, two[0].uid);
  assert.notEqual(one[0].hash, two[0].hash);
  assert.equal(await snapshotEntities('<html>', 'page.html'), undefined, 'uncharted language');
});
