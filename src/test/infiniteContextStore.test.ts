import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
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
