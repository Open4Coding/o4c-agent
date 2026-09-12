import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, deriveTitle } from '../session/sessionStore.js';
import type { Message } from '../providers/types.js';

// Every test gets its own real temp directory - never touches the actual ~/.o4c/sessions.
async function withTempStore(fn: (store: SessionStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-session-test-'));
  try {
    await fn(new SessionStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function userMsg(content: string): Message {
  return { role: 'user', content };
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
    const id = await store.save([userMsg('hello there')]);
    assert.ok(id);

    const manifest = await store.readManifest();
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, id);
    assert.equal(manifest[0].title, 'hello there');
    assert.equal(manifest[0].messageCount, 1);

    const loaded = await store.load(id);
    assert.ok(loaded);
    assert.deepEqual(loaded.messages, [userMsg('hello there')]);
  });
});

test('save() with an existing id updates in place instead of creating a second entry', async () => {
  await withTempStore(async (store) => {
    const id = await store.save([userMsg('first')]);
    const secondId = await store.save([userMsg('first'), { role: 'assistant', content: 'reply' }], id);

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
    const idA = await store.save([userMsg('session A')]);
    const idB = await store.save([userMsg('session B')]);
    // idB is currently newest. Now touch A again - it should become newest.
    await store.save([userMsg('session A'), { role: 'assistant', content: 'more' }], idA);

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
    const id = await store.save([userMsg('to be deleted')]);
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

test('save() refuses to persist a session with zero messages', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(() => store.save([]));
  });
});

test('the manifest is capped at 20 entries, oldest pruned first, and its file is actually deleted', async () => {
  await withTempStore(async (store, dir) => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      ids.push(await store.save([userMsg(`session ${i}`)]));
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
