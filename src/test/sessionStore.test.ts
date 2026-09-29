import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, deriveTitle } from '../session/sessionStore.js';
import { userInputEntry, aiResponseEntry, type ContextEntry } from '../agent/contextEntry.js';

// Every test gets its own real temp directory - never touches the actual ~/.o4c/sessions.
async function withTempStore(
  fn: (store: SessionStore, dir: string) => Promise<void>,
  maxSessions?: number,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-session-test-'));
  try {
    await fn(new SessionStore(dir, maxSessions), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `id`/`created_at`/`session_id` are generated/stamped, not meaningful to compare exactly -
// strips them down to the fields a test actually cares about.
function summarize(entries: readonly ContextEntry[]) {
  return entries.map((e) => ({ type: e.type, sub_type: e.sub_type, content: e.content }));
}

test('deriveTitle uses the message as-is when short enough', () => {
  assert.equal(deriveTitle('fix the bug'), 'fix the bug');
});

test('deriveTitle collapses whitespace and truncates long messages with an ellipsis', () => {
  const long = 'a'.repeat(80);
  const title = deriveTitle(long);
  assert.ok(title.length <= 50);
  assert.ok(title.endsWith('…'));
});

test('deriveTitle falls back to a placeholder for an empty/whitespace-only message', () => {
  assert.equal(deriveTitle('   '), '(empty message)');
});

test('readManifest is empty before any session is ever saved', async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.readManifest(), []);
  });
});

test('save() creates a new session file and a manifest entry, and returns a usable id', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userInputEntry('hello there')]);
    assert.ok(id);

    const manifest = await store.readManifest();
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, id);
    assert.equal(manifest[0].title, 'hello there');
    assert.equal(manifest[0].messageCount, 1);

    const loaded = await store.load(id);
    assert.ok(loaded);
    assert.deepEqual(summarize(loaded.entries), [{ type: 'user', sub_type: 'input', content: 'hello there' }]);
    // session_id is stamped in at save time, not left blank as AgentLoop originally created it.
    assert.equal(loaded.entries[0].session_id, id);
  });
});

test('save() persists inputHistory alongside entries, and load() returns it back', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userInputEntry('hello there')], undefined, ['first draft', 'second draft']);

    const loaded = await store.load(id);
    assert.ok(loaded);
    assert.deepEqual(loaded.inputHistory, ['first draft', 'second draft']);
  });
});

test('save() without inputHistory leaves it undefined in the loaded result, not an empty array', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userInputEntry('hello there')]);

    const loaded = await store.load(id);
    assert.ok(loaded);
    assert.equal(loaded.inputHistory, undefined);
  });
});

test('load() on a pre-existing session file saved before this project used entries at all still loads fine', async () => {
  await withTempStore(async (store, dir) => {
    // Simulates a real session file from before the §5.1 ContextEntry refactor - plain
    // `messages: Message[]`, no `entries` key at all. `load()` must lift it, not just fail.
    await writeFile(
      join(dir, 'old-session.json'),
      JSON.stringify({
        id: 'old-session',
        title: 'an old session',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messageCount: 1,
        messages: [{ role: 'user', content: 'hello there' }],
      }),
      'utf-8',
    );

    const loaded = await store.load('old-session');
    assert.ok(loaded);
    assert.deepEqual(summarize(loaded.entries), [{ type: 'user', sub_type: 'input', content: 'hello there' }]);
    assert.equal(loaded.inputHistory, undefined);
  });
});

test('save() with an existing id updates in place instead of creating a second entry', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userInputEntry('first')]);
    const secondId = await store.save([userInputEntry('first'), aiResponseEntry('reply')], id);

    assert.equal(secondId, id);
    const manifest = await store.readManifest();
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].messageCount, 2);
    // Title stays pinned to the first save, not re-derived from later content.
    assert.equal(manifest[0].title, 'first');
  });
});

test('saving an existing session bubbles it back to the front of the manifest', async () => {
  await withTempStore(async (store) => {
    const idA = await store.save([userInputEntry('session A')]);
    const idB = await store.save([userInputEntry('session B')]);
    // idB is currently newest. Now touch A again - it should become newest.
    await store.save([userInputEntry('session A'), aiResponseEntry('more')], idA);

    const manifest = await store.readManifest();
    assert.deepEqual(
      manifest.map((m) => m.id),
      [idA, idB],
    );
  });
});

test('load() returns undefined for an id that was never saved', async () => {
  await withTempStore(async (store) => {
    assert.equal(await store.load('does-not-exist'), undefined);
  });
});

test('delete() removes both the session file and its manifest entry', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userInputEntry('to be deleted')]);
    assert.ok(await store.load(id));

    await store.delete(id);

    assert.equal(await store.load(id), undefined);
    assert.deepEqual(await store.readManifest(), []);
  });
});

test('delete() on an id that does not exist is a harmless no-op', async () => {
  await withTempStore(async (store) => {
    await store.delete('never-existed'); // must not throw
    assert.deepEqual(await store.readManifest(), []);
  });
});

test('rename() overwrites the title in both the manifest entry and the session file itself', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userInputEntry('original first message')]);

    await store.rename(id, 'my custom name');

    const data = await store.load(id);
    assert.equal(data?.title, 'my custom name');
    const manifest = await store.readManifest();
    assert.equal(manifest.find((m) => m.id === id)?.title, 'my custom name');
  });
});

test('rename() throws for an id that does not exist, unlike delete()\'s silent no-op', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(() => store.rename('never-existed', 'anything'));
  });
});

test('save() refuses to persist a session with zero entries', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(() => store.save([]));
  });
});

test('the manifest is capped at 20 entries, oldest pruned first, and its file is actually deleted', async () => {
  await withTempStore(async (store, dir) => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      ids.push(await store.save([userInputEntry(`session ${i}`)]));
    }

    const manifest = await store.readManifest();
    assert.equal(manifest.length, 20);

    // The very first session (oldest) should have been pruned, its 21st sibling kept.
    const survivingIds = manifest.map((m) => m.id);
    assert.equal(survivingIds.includes(ids[0]), false);
    assert.equal(survivingIds.includes(ids[20]), true);

    // Pruning must delete the actual file, not just drop it from the manifest.
    assert.equal(await store.load(ids[0]), undefined);
  });
});

test('maxSessions is configurable via the constructor, not hardcoded at 20 (front-end plan item #9)', async () => {
  await withTempStore(async (store) => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await store.save([userInputEntry(`session ${i}`)]));
    }

    const manifest = await store.readManifest();
    assert.equal(manifest.length, 3);
    assert.equal(manifest.some((m) => m.id === ids[0]), false); // oldest pruned at the new, lower cap
  }, 3);
});

test('maxSessions can be mutated live on an existing instance and takes effect on the next save', async () => {
  await withTempStore(async (store) => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await store.save([userInputEntry(`session ${i}`)]));
    }
    assert.equal((await store.readManifest()).length, 3); // under the default cap so far, nothing pruned

    // /set-sessionsToSave's own live-update path (App.tsx) - no new SessionStore instance needed.
    store.maxSessions = 2;
    ids.push(await store.save([userInputEntry('session 3')]));

    const manifest = await store.readManifest();
    assert.equal(manifest.length, 2);
    assert.equal(manifest.some((m) => m.id === ids[0]), false); // pruned under the new, lower cap
  });
});
