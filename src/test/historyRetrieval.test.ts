import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { HistoryRetrieval, exactNames, ftsQuery, meaningfulTerms, qualifies } from '../session/retrieval.js';
import { createHistoryTool } from '../session/historyTool.js';
import { markWorkedCommand } from '../session/workedCommand.js';

/**
 * NextUp item 23, checklist B4/B5: finding past tasks - the qualification rule, ranking, threads,
 * staleness, the pointer hint and the search_history tool - against a real store.
 */

async function withHistory(
  fn: (ctx: { store: InfiniteContextStore; retrieval: HistoryRetrieval; exists: Map<string, boolean | undefined> }) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-retrieval-test-'));
  const store = new InfiniteContextStore(join(dir, 'history.db'));
  store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
  const exists = new Map<string, boolean | undefined>();
  const retrieval = new HistoryRetrieval({
    store,
    sessionId: 's1',
    currentTask: () => undefined,
    entityExists: (uid) => (exists.has(uid) ? exists.get(uid) : true),
  });
  try {
    await fn({ store, retrieval, exists });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('meaningful words drop stopwords and generic verbs; exact names are files and identifiers', () => {
  assert.deepEqual(meaningfulTerms('Please fix the CRLF bug in the installer'), ['crlf', 'bug', 'installer']);
  assert.deepEqual(exactNames('look at tetris.html and src\\ui\\App.tsx, then formatEvent and tool_call_id'), [
    'tetris.html',
    'src/ui/App.tsx',
    'formatEvent',
    'tool_call_id',
  ]);
  assert.deepEqual(exactNames('a plain sentence with Words in it.'), []);
});

test('ftsQuery quotes every term, so nothing typed is read as FTS5 syntax', () => {
  assert.equal(ftsQuery('the "installer" NEAR bug'), '"installer" OR "near" OR "bug"');
  assert.equal(ftsQuery('fix it please'), undefined, 'nothing meaningful, no search at all');
});

test('qualifies: two shared meaningful words, or one exact file name or identifier', () => {
  const task = { title: 'fix the CRLF bug in the bat installer', request: 'fix the CRLF bug in the bat installer', files: 'scripts/install.bat' };
  assert.equal(qualifies(task, 'the installer has a CRLF problem again'), true);
  assert.equal(qualifies(task, 'the installer is slow'), false, 'one shared word is not enough');
  assert.equal(qualifies(task, 'something is wrong in install.bat'), true, 'an exact file name alone qualifies');
});

test('rank: follow-ups collapse into their thread, shown under the top-level number', async () => {
  await withHistory(({ store, retrieval }) => {
    const root = store.startTask({ session_id: 's1', request: 'build tetris rotation logic' });
    store.startTask({ session_id: 's1', request: 'rotation still wrong', followUpOf: root.id });
    const threads = retrieval.rank('tetris rotation');
    assert.equal(threads.length, 1);
    assert.equal(threads[0].number, `#${root.id}`);
    assert.equal(threads[0].followUps, 1);
  });
});

test('rank: a task marked worked outranks an equally relevant one; one marked as not working sinks', async () => {
  await withHistory(({ store, retrieval }) => {
    const a = store.startTask({ session_id: 's1', request: 'parser crash on empty input' });
    const b = store.startTask({ session_id: 's1', request: 'parser crash on empty input' });
    store.markWorked(a.id, true);
    store.markWorked(b.id, false);
    assert.deepEqual(retrieval.rank('parser crash').map((t) => t.root.id), [a.id, b.id]);
  });
});

test('rank leaves out the task that is running now', async () => {
  await withHistory(({ store }) => {
    const older = store.startTask({ session_id: 's1', request: 'parser crash on empty input' });
    const running = store.startTask({ session_id: 's1', request: 'parser crash again' });
    const retrieval = new HistoryRetrieval({ store, sessionId: 's1', currentTask: () => running.id });
    assert.deepEqual(retrieval.rank('parser crash').map((t) => t.root.id), [older.id]);
  });
});

test('staleness: gone code marks a thread stale; an index that cannot say leaves it unknown', async () => {
  await withHistory(({ store, retrieval, exists }) => {
    const task = store.startTask({ session_id: 's1', request: 'refactor scoring in tetris' });
    store.addTaskEntity({ task_id: task.id, path: 'game.ts', entity_uid: 'u1', name: 'score', kind: 'function', change: 'modified', hash_before: 'a', hash_after: 'b' });
    assert.equal(retrieval.rank('tetris scoring')[0].stale, false);
    exists.set('u1', undefined);
    assert.equal(retrieval.rank('tetris scoring')[0].stale, undefined);
    exists.set('u1', false);
    assert.equal(retrieval.rank('tetris scoring')[0].stale, true);
  });
});

test('pointer hint: nothing qualifying sends nothing and logs nothing; a match names the thread', async () => {
  await withHistory(({ store, retrieval }) => {
    const task = store.startTask({ session_id: 's1', request: 'fix the CRLF bug in the bat installer' });
    store.finishTask(task.id);
    assert.equal(retrieval.pointerHint('write a haiku about autumn'), undefined);
    assert.equal(retrieval.pointerHint('the installer is slow'), undefined, 'one word in common does not qualify');

    const hint = retrieval.pointerHint('the installer has a CRLF problem again')!;
    assert.match(hint, new RegExp(`^\\[o4c history\\] Past tasks that may help: #${task.id} "fix the CRLF bug in the bat installer"`));
    assert.match(hint, /search_history \{"open": "#\d+"\}/);
  });
});

test('search_history: query lists by number; open shows the key parts and counts as a pick', async () => {
  await withHistory(async ({ store, retrieval }) => {
    const task = store.startTask({ session_id: 's1', request: 'fix the CRLF bug in the bat installer' });
    store.setTaskAnswer(task.id, 'Normalised the batch file to CRLF and tested the shipped bytes.');
    store.addTaskFile(task.id, 'scripts/install.bat');
    store.addTaskEntity({ task_id: task.id, path: 'scripts/install.bat', entity_uid: null, name: null, kind: null, change: 'written', hash_before: null, hash_after: null });
    store.finishTask(task.id);
    const follow = store.startTask({ session_id: 's1', request: 'still broken', followUpOf: task.id });
    store.finishTask(follow.id);
    const tool = createHistoryTool(store, retrieval);

    const listing = await tool.execute({ query: 'CRLF installer' });
    assert.match(listing, /1 past task match "CRLF installer":/);
    assert.match(listing, new RegExp(`#${task.id} fix the CRLF bug in the bat installer \\(\\+1 follow-up\\); files: scripts/install.bat`));

    const opened = await tool.execute({ open: `#${task.id}` });
    assert.match(opened, /Outcome: done, /);
    assert.match(opened, /Answer: Normalised the batch file/);
    assert.match(opened, /Files written: scripts\/install.bat/);
    assert.match(opened, new RegExp(`Same thread:\\n  #${task.id}\\.1 still broken`));
    assert.equal(store.getTask(task.id)!.used_count, 1, 'opening a listed task is a pick');

    assert.match(await tool.execute({ open: `#${follow.parent_task_id}.1` }), /Answer: \[none recorded, or archived\]/);
    assert.match(await tool.execute({ open: '#9999' }), /No past task #9999/);
    assert.match(await tool.execute({ query: 'haiku autumn' }), /No past tasks match/);
    assert.match(await tool.execute({}), /Pass \{"query"/);
  });
});

test('/worked marks the session\'s latest task by default, or a numbered one; no, clear and bad input', async () => {
  await withHistory(({ store }) => {
    assert.match(markWorkedCommand(store, 's1', ''), /Nothing to mark yet/);
    const first = store.startTask({ session_id: 's1', request: 'fix the CRLF bug in the bat installer' });
    const last = store.startTask({ session_id: 's1', request: 'write the README' });

    assert.equal(markWorkedCommand(store, 's1', ''), `Marked #${last.id} "write the README" as worked - history search will rank it higher.`);
    assert.equal(store.getTask(last.id)!.worked, 1);
    assert.match(markWorkedCommand(store, 's1', ` #${first.id} no`), /as did not work/);
    assert.equal(store.getTask(first.id)!.worked, 0);
    assert.match(markWorkedCommand(store, 's1', `clear #${first.id}`), /Cleared the mark/);
    assert.equal(store.getTask(first.id)!.worked, null);
    assert.match(markWorkedCommand(store, 's1', '#9999'), /No task #9999/);
    assert.match(markWorkedCommand(store, 's1', 'maybe'), /^Usage: \/worked/);
  });
});
