import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { HistoryRecorder } from '../session/historyRecorder.js';
import { aiResponseEntry, userInputEntry } from '../agent/contextEntry.js';
import { markIncorrect, markIncorrectCommand, setIncorrectMarker } from '../session/workedCommand.js';

async function withTask(fn: (store: InfiniteContextStore) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'o4c-incorrect-'));
  const store = new InfiniteContextStore(join(root, '.o4c', 'db', 'history.db'));
  const recorder = new HistoryRecorder({ store, sessionId: 's1', projectRoot: root, enabled: () => true });
  try {
    recorder.onEntry(userInputEntry('sum the column'));
    recorder.onEntry(aiResponseEntry('The total is 42.'));
    fn(store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('/mark-incorrect marks the last task as not working and keeps the reason in its errors', async () => {
  await withTask((store) => {
    const msg = markIncorrectCommand(store, 's1', ' it skipped the header row ');
    assert.match(msg, /as incorrect \(reason kept with it\)/);
    const task = store.lastTask('s1')!;
    assert.equal(task.worked, 0);
    assert.match(task.errors, /Marked incorrect by the user: it skipped the header row/);
    markIncorrectCommand(store, 's1', 'and the footer');
    assert.match(store.lastTask('s1')!.errors, /header row\nMarked incorrect by the user: and the footer/, 'a second reason is added, not replacing');
  });
});

test('/mark-incorrect takes a task number first, and says so when there is nothing to mark', async () => {
  await withTask((store) => {
    assert.match(markIncorrectCommand(store, 's1', '#999 wrong'), /No task #999/);
    assert.match(markIncorrectCommand(store, 'other-session', ''), /Nothing to mark yet/);
    assert.match(markIncorrectCommand(store, 's1', ''), /as incorrect - history search will rank it lower\./);
    assert.match(store.lastTask('s1')!.errors, /Marked incorrect by the user\./);
  });
});

test('markIncorrect without history says what it needs', () => {
  setIncorrectMarker(undefined);
  assert.match(markIncorrect('x'), /needs a trusted project/);
  setIncorrectMarker((arg) => `got ${arg}`);
  assert.equal(markIncorrect('y'), 'got y');
  setIncorrectMarker(undefined);
});
