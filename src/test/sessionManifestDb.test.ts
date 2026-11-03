import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session/sessionStore.js';
import type { ContextEntry } from '../agent/contextEntry.js';

const entry = (content: string) => ({ type: 'user', sub_type: 'input', content }) as unknown as ContextEntry;

test('an existing index.json is imported once, in order, and kept as .migrated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-manifest-'));
  try {
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify([
        { id: 'newest', title: 'B', createdAt: 't2', updatedAt: 't2', messageCount: 2 },
        { id: 'older', title: 'A', createdAt: 't1', updatedAt: 't1', messageCount: 1 },
      ]),
    );
    const store = new SessionStore(dir);
    assert.deepEqual((await store.readManifest()).map((m) => m.id), ['newest', 'older']);
    assert.equal(existsSync(join(dir, 'index.json')), false);
    assert.equal(existsSync(join(dir, 'index.json.migrated')), true);
    await store.save([entry('third')], 'older');
    assert.deepEqual((await store.readManifest()).map((m) => m.id), ['older', 'newest'], 'a save bubbles the session to the top');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two stores saving at the same time both keep their session (the old index.json race)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-manifest-'));
  try {
    const a = new SessionStore(dir);
    const b = new SessionStore(dir);
    const ids = await Promise.all([a.save([entry('from a')]), b.save([entry('from b')]), a.save([entry('a again')]), b.save([entry('b again')])]);
    const manifest = await a.readManifest();
    assert.deepEqual(manifest.map((m) => m.id).sort(), [...ids].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest sits in .o4c/db/sessions.db beside the other databases, and pruning still works', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-manifest-'));
  try {
    const sessions = join(root, '.o4c', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const store = new SessionStore(sessions, 2);
    const first = await store.save([entry('one')]);
    await store.save([entry('two')]);
    await store.save([entry('three')]);
    assert.equal(existsSync(join(root, '.o4c', 'db', 'sessions.db')), true);
    const manifest = await store.readManifest();
    assert.equal(manifest.length, 2);
    assert.equal(manifest.some((m) => m.id === first), false);
    assert.equal(await store.load(first), undefined, 'the pruned session file is gone too');
    await store.rename(manifest[0]!.id, 'renamed');
    assert.equal((await store.readManifest())[0]!.title, 'renamed');
    await store.delete(manifest[0]!.id);
    assert.equal((await store.readManifest()).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
