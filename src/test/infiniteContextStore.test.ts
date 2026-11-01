import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HISTORY_SCHEMA_VERSION,
  InfiniteContextStore,
  INFINITE_CONTEXT_DB_FILENAME,
  TASK_TITLE_CHARS,
  deriveTaskTitle,
  taskNumber,
} from '../session/infiniteContextStore.js';
import { userInputEntry, aiResponseEntry, aiToolCallEntry, type ContextEntry } from '../agent/contextEntry.js';

async function withStore(fn: (store: InfiniteContextStore, dbPath: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-infinitecontext-test-'));
  const dbPath = join(dir, INFINITE_CONTEXT_DB_FILENAME);
  const store = new InfiniteContextStore(dbPath);
  try {
    fn(store, dbPath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function withSessionId(entry: ContextEntry, sessionId: string): ContextEntry {
  return { ...entry, session_id: sessionId };
}

test('constructing the store creates the db file and directory on disk', async () => {
  await withStore((_store, dbPath) => {
    assert.ok(existsSync(dbPath));
  });
});

test('insertEntry throws if session_id is not yet stamped', async () => {
  await withStore((store) => {
    assert.throws(() => store.insertEntry(userInputEntry('hello')), /session_id/);
  });
});

test('insertEntry throws if the referenced session was never created', async () => {
  await withStore((store) => {
    assert.throws(() => store.insertEntry(withSessionId(userInputEntry('hello'), 'no-such-session')));
  });
});

test('ensureSession + insertEntry round-trips a real entry, readable back by its entry_uid', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 'test session', started_at: Date.now() });
    const entry = withSessionId(userInputEntry('what is the capital of France'), 's1');
    store.insertEntry(entry);

    const row = store.getByUid(entry.id);
    assert.ok(row);
    assert.equal(row!.entry_uid, entry.id);
    assert.equal(row!.type, 'user');
    assert.equal(row!.sub_type, 'input');
    assert.equal(row!.session_id, 's1');
    assert.equal(row!.content, 'what is the capital of France');
    assert.equal(row!.redacted, 0);
    assert.equal(row!.is_correct, null);
  });
});

test('ensureSession is idempotent - inserting the same session id twice does not throw', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 'a', started_at: 1 });
    store.ensureSession({ id: 's1', title: 'b', started_at: 2 });
  });
});

test('is_correct and mutating map booleans to the SQL tri-state/int convention', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const correct: ContextEntry = withSessionId({ ...aiResponseEntry('Paris'), is_correct: true }, 's1');
    const incorrect: ContextEntry = withSessionId({ ...aiResponseEntry('Lyon'), is_correct: false }, 's1');
    const unmarked: ContextEntry = withSessionId(aiResponseEntry('Marseille'), 's1');
    store.insertEntry(correct);
    store.insertEntry(incorrect);
    store.insertEntry(unmarked);

    assert.equal(store.getByUid(correct.id)!.is_correct, 1);
    assert.equal(store.getByUid(incorrect.id)!.is_correct, 0);
    assert.equal(store.getByUid(unmarked.id)!.is_correct, null);
  });
});

test('a toolcall entry persists tool_call_id and mutating', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const call = withSessionId(
      aiToolCallEntry({ id: 'call-1', name: 'write_file', input: { path: 'x' } }, true),
      's1',
    );
    store.insertEntry(call);

    const row = store.getByUid(call.id);
    assert.equal(row!.tool_call_id, 'call-1');
    assert.equal(row!.mutating, 1);
  });
});

test('listByType returns matching rows, most recent first', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    store.insertEntry(withSessionId(userInputEntry('first'), 's1'));
    store.insertEntry(withSessionId(aiResponseEntry('a response'), 's1'));
    store.insertEntry(withSessionId(userInputEntry('second'), 's1'));

    const inputs = store.listByType('user', 'input');
    assert.deepEqual(inputs.map((r) => r.content), ['second', 'first']);
  });
});

test('search finds a full-text match and respects narrowing filters', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const match = withSessionId(aiResponseEntry('the capital of France is Paris'), 's1');
    const nonMatch = withSessionId(aiResponseEntry('unrelated content entirely'), 's1');
    store.insertEntry(match);
    store.insertEntry(nonMatch);

    const results = store.search('Paris');
    assert.equal(results.length, 1);
    assert.equal(results[0].entry_uid, match.id);

    const filtered = store.search('Paris', { type: 'ai', sub_type: 'response' });
    assert.equal(filtered.length, 1);

    const wrongType = store.search('Paris', { type: 'user' });
    assert.equal(wrongType.length, 0);
  });
});

test('search combined with is_correct filter only surfaces the marked-correct match', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const correct: ContextEntry = withSessionId({ ...aiResponseEntry('Paris is the capital'), is_correct: true }, 's1');
    const wrong: ContextEntry = withSessionId({ ...aiResponseEntry('Paris is a small village'), is_correct: false }, 's1');
    store.insertEntry(correct);
    store.insertEntry(wrong);

    const results = store.search('Paris', { is_correct: true });
    assert.equal(results.length, 1);
    assert.equal(results[0].entry_uid, correct.id);
  });
});

test('tags: ensureTag + tagEntryByUid link an entry to a tag, entriesByTag finds it back', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const entry = withSessionId(aiResponseEntry('rate limited by the provider'), 's1');
    store.insertEntry(entry);
    store.tagEntryByUid(entry.id, 'rate-limit', 'provider-error');

    const byChild = store.entriesByTag('rate-limit');
    assert.equal(byChild.length, 1);
    assert.equal(byChild[0].entry_uid, entry.id);

    // Recursive hierarchy walk: querying the parent tag also finds the child-tagged entry.
    const byParent = store.entriesByTag('provider-error');
    assert.equal(byParent.length, 1);
    assert.equal(byParent[0].entry_uid, entry.id);

    // Non-recursive form only matches the exact tag.
    const exactParentOnly = store.entriesByTag('provider-error', false);
    assert.equal(exactParentOnly.length, 0);
  });
});

test('insertEntry writes tags carried directly on ContextEntry.tags', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const entry: ContextEntry = withSessionId({ ...aiResponseEntry('oops'), tags: ['error'] }, 's1');
    store.insertEntry(entry);

    const found = store.entriesByTag('error');
    assert.equal(found.length, 1);
    assert.equal(found[0].entry_uid, entry.id);
  });
});

// ---- Tasks, follow-ups, entity links, search log (brief 0004, NextUp items 13/23) ----

test('a fresh store stamps its schema version', async () => {
  await withStore((store) => {
    assert.equal(store.schemaVersion(), HISTORY_SCHEMA_VERSION);
  });
});

test('deriveTaskTitle: first non-empty line, whitespace collapsed, cut at the limit', () => {
  assert.equal(deriveTaskTitle('\n\n  fix   the CRLF bug\nin the installer'), 'fix the CRLF bug');
  const long = deriveTaskTitle('word '.repeat(40));
  assert.equal(long.length, TASK_TITLE_CHARS);
  assert.ok(long.endsWith('...'));
  assert.equal(deriveTaskTitle(''), '');
});

test('startTask opens a top-level task titled from the request; entries are filed under it', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const task = store.startTask({ session_id: 's1', request: 'create a copy of the game tetris in html' });
    assert.equal(task.title, 'create a copy of the game tetris in html');
    assert.equal(task.parent_task_id, null);
    assert.equal(task.sub_no, 0);
    assert.equal(task.outcome, 'open');
    assert.equal(taskNumber(task), `#${task.id}`);

    const entry = withSessionId(userInputEntry('create a copy of the game tetris in html'), 's1');
    store.insertEntry(entry, task.id);
    assert.equal(store.getByUid(entry.id)!.task_id, task.id);
  });
});

test('follow-ups number under the top-level task, and a follow-up of a follow-up joins the same thread', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const root = store.startTask({ session_id: 's1', request: 'make tetris' });
    const first = store.startTask({ session_id: 's1', request: 'try again', followUpOf: root.id });
    const second = store.startTask({ session_id: 's1', request: 'faster', followUpOf: first.id });
    assert.equal(taskNumber(first), `#${root.id}.1`);
    assert.equal(taskNumber(second), `#${root.id}.2`);
    assert.deepEqual(store.followUps(root.id).map((t) => t.id), [first.id, second.id]);
    assert.equal(store.getTaskByNumber(`#${root.id}.2`)!.id, second.id);
    assert.equal(store.getTaskByNumber(String(root.id))!.id, root.id);
    assert.equal(store.getTaskByNumber('nonsense'), undefined);
    assert.equal(store.lastTask('s1')!.id, second.id);
  });
});

test('key parts: answer, bounded errors, files once; finishTask decides done or incomplete', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const answered = store.startTask({ session_id: 's1', request: 'a' });
    store.setTaskAnswer(answered.id, 'the answer');
    store.addTaskFile(answered.id, 'src/a.ts');
    store.addTaskFile(answered.id, 'src/a.ts');
    store.addTaskFile(answered.id, 'src/b.ts');
    for (let i = 0; i < 50; i++) store.addTaskError(answered.id, `Command failed ${i} ${'x'.repeat(500)}`);
    store.finishTask(answered.id);

    const row = store.getTask(answered.id)!;
    assert.equal(row.files, 'src/a.ts\nsrc/b.ts');
    assert.ok(row.errors.length <= 2000, 'errors stay bounded');
    assert.equal(row.outcome, 'done');
    assert.ok(row.finished_at);

    const silent = store.startTask({ session_id: 's1', request: 'b' });
    store.finishTask(silent.id);
    assert.equal(store.getTask(silent.id)!.outcome, 'incomplete');
  });
});

test('searchTasks ranks over the key parts and leaves out the running task', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const crlf = store.startTask({ session_id: 's1', request: 'fix the CRLF bug in the bat installer' });
    store.addTaskFile(crlf.id, 'scripts/install.bat');
    const other = store.startTask({ session_id: 's1', request: 'write a README' });
    const running = store.startTask({ session_id: 's1', request: 'the installer CRLF bug is back' });

    const hits = store.searchTasks('"crlf" OR "installer"', 10, running.id);
    assert.deepEqual(hits.map((h) => h.id), [crlf.id]);
    assert.ok(hits[0].bm25 < 0, 'FTS5 bm25: more negative is more relevant');
    assert.equal(store.searchTasks('"readme"').map((h) => h.id)[0], other.id);
  });
});

test('task_entities link a task to definitions and files, both directions', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const task = store.startTask({ session_id: 's1', request: 'rotate fix' });
    store.addTaskEntity({
      task_id: task.id, path: 'tetris.js', entity_uid: 'uid-tryRotate', name: 'tryRotate', kind: 'function',
      change: 'modified', hash_before: 'h1', hash_after: 'h2',
    });
    store.addTaskEntity({
      task_id: task.id, path: 'tetris.html', entity_uid: null, name: null, kind: null,
      change: 'written', hash_before: null, hash_after: null,
    });
    assert.equal(store.taskEntities(task.id).length, 2);
    assert.equal(store.tasksForEntity('uid-tryRotate')[0].id, task.id);
    assert.equal(store.tasksForPath('tetris.html')[0].id, task.id);
  });
});

test('search_log: a search records what it showed, picks are recorded and counted as used', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const a = store.startTask({ session_id: 's1', request: 'a' });
    const b = store.startTask({ session_id: 's1', request: 'b' });
    const searchId = store.recordSearch({ session_id: 's1', task_id: b.id, source: 'tool', query: 'x', shown: [a.id] });
    store.recordPicks(searchId, [a.id]);
    store.recordPicks(searchId, [a.id]);
    assert.equal(store.getTask(a.id)!.used_count, 2);
    assert.equal(store.getTask(b.id)!.used_count, 0);
  });
});

test('markWorked sets and clears the manual mark', async () => {
  await withStore((store) => {
    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const task = store.startTask({ session_id: 's1', request: 'a' });
    assert.equal(task.worked, null);
    store.markWorked(task.id, true);
    assert.equal(store.getTask(task.id)!.worked, 1);
    store.markWorked(task.id, null);
    assert.equal(store.getTask(task.id)!.worked, null);
  });
});
