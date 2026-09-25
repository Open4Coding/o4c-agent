import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, seedLocalConfig } from '../session/configStore.js';

async function withTempDirs(
  fn: (globalDir: string, projectRoot: string) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'o4c-config-test-'));
  try {
    const globalDir = join(base, 'global');
    const projectRoot = join(base, 'project');
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await fn(globalDir, projectRoot);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('readScope returns {} for a scope whose config.json does not exist yet', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    assert.deepEqual(await store.readScope('global'), {});
    assert.deepEqual(await store.readScope('local'), {});
  });
});

test('hasScope is false for local with no trusted project, true otherwise', async () => {
  await withTempDirs(async (globalDir) => {
    const untrusted = new ConfigStore(undefined, globalDir);
    assert.equal(untrusted.hasScope('local'), false);
    assert.equal(untrusted.hasScope('global'), true);

    const trusted = new ConfigStore('/some/project', globalDir);
    assert.equal(trusted.hasScope('local'), true);
  });
});

test('set() writes into exactly the requested scope, readable back from that same scope', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    await store.set('global', 'theme', 'dark');
    await store.set('local', 'theme', 'light');

    assert.deepEqual(await store.readScope('global'), { theme: 'dark' });
    assert.deepEqual(await store.readScope('local'), { theme: 'light' });
  });
});

test('set() merges into the scope\'s existing content rather than overwriting the whole file', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    await store.set('global', 'a', 1);
    await store.set('global', 'b', 2);

    assert.deepEqual(await store.readScope('global'), { a: 1, b: 2 });
  });
});

test('resolve() deep-merges the two scopes, local winning on conflicting keys', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    await store.set('global', 'theme', 'dark');
    await store.set('global', 'onlyGlobal', true);
    await store.set('local', 'theme', 'light');

    const resolved = await store.resolve();
    assert.equal(resolved.theme, 'light'); // local wins
    assert.equal(resolved.onlyGlobal, true); // falls through from global untouched
  });
});

test('get() reads a single key from the effective (merged) view', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    await store.set('global', 'theme', 'dark');
    await store.set('local', 'theme', 'light');

    assert.equal(await store.get('theme'), 'light');
    assert.equal(await store.get('neverSet'), undefined);
  });
});

test('set(\'local\', ...) throws with no trusted project, instead of silently writing somewhere unexpected', async () => {
  await withTempDirs(async (globalDir) => {
    const store = new ConfigStore(undefined, globalDir);
    await assert.rejects(() => store.set('local', 'theme', 'dark'));
  });
});

test('seedLocalConfig copies the global config.json into a fresh local one', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await writeFile(join(globalDir, 'config.json'), JSON.stringify({ theme: 'dark' }), 'utf-8');

    await seedLocalConfig(projectRoot, globalDir);

    const localRaw = await readFile(join(projectRoot, '.o4c', 'config.json'), 'utf-8');
    assert.deepEqual(JSON.parse(localRaw), { theme: 'dark' });
  });
});

test('seedLocalConfig is a no-op when the global config.json does not exist yet', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await seedLocalConfig(projectRoot, globalDir);

    await assert.rejects(() => readFile(join(projectRoot, '.o4c', 'config.json'), 'utf-8'));
  });
});

test('seedLocalConfig never overwrites an already-existing local config.json', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await writeFile(join(globalDir, 'config.json'), JSON.stringify({ theme: 'dark' }), 'utf-8');
    await mkdir(join(projectRoot, '.o4c'), { recursive: true });
    await writeFile(
      join(projectRoot, '.o4c', 'config.json'),
      JSON.stringify({ theme: 'already-here' }),
      'utf-8',
    );

    await seedLocalConfig(projectRoot, globalDir);

    const localRaw = await readFile(join(projectRoot, '.o4c', 'config.json'), 'utf-8');
    assert.deepEqual(JSON.parse(localRaw), { theme: 'already-here' });
  });
});

test('after seeding, local and global start identical but change independently afterward', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await writeFile(join(globalDir, 'config.json'), JSON.stringify({ theme: 'dark' }), 'utf-8');
    await seedLocalConfig(projectRoot, globalDir);

    const store = new ConfigStore(projectRoot, globalDir);
    assert.deepEqual(await store.readScope('local'), { theme: 'dark' });

    // A further global-side change must not retroactively touch the already-seeded local copy.
    await store.set('global', 'theme', 'light');
    assert.deepEqual(await store.readScope('local'), { theme: 'dark' });
    assert.deepEqual(await store.readScope('global'), { theme: 'light' });
  });
});

test('seedLocalConfig deep-merges a profileBundle over the global copy, profile winning on conflicts', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({ provider: 'anthropic', theme: 'dark' }),
      'utf-8',
    );

    await seedLocalConfig(projectRoot, globalDir, { provider: 'local', activePlugins: ['x'] });

    const localRaw = await readFile(join(projectRoot, '.o4c', 'config.json'), 'utf-8');
    assert.deepEqual(JSON.parse(localRaw), {
      provider: 'local',
      theme: 'dark',
      activePlugins: ['x'],
    });
  });
});

test('seedLocalConfig writes just the profileBundle when there is no global config.json at all', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    await seedLocalConfig(projectRoot, globalDir, { provider: 'local' });

    const localRaw = await readFile(join(projectRoot, '.o4c', 'config.json'), 'utf-8');
    assert.deepEqual(JSON.parse(localRaw), { provider: 'local' });
  });
});

test('personal scope (config.local.json) resolves with the highest precedence, above local and global', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    await store.set('global', 'theme', 'dark');
    await store.set('local', 'theme', 'light');
    await store.set('personal', 'theme', 'high-contrast');

    assert.deepEqual(await store.resolve(), { theme: 'high-contrast' });
    // Each scope's own file is untouched by writing to another scope.
    assert.deepEqual(await store.readScope('global'), { theme: 'dark' });
    assert.deepEqual(await store.readScope('local'), { theme: 'light' });
  });
});

test('personal scope writes to config.local.json, a separate file from local\'s config.json', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const store = new ConfigStore(projectRoot, globalDir);
    await store.set('personal', 'apiKey', 'secret');

    const raw = await readFile(join(projectRoot, '.o4c', 'config.local.json'), 'utf-8');
    assert.deepEqual(JSON.parse(raw), { apiKey: 'secret' });
    // A pull that changed the shared config.json must never be able to touch this file - proven
    // structurally here by it simply being a different filename set() never writes to for 'local'.
    await assert.rejects(() => readFile(join(projectRoot, '.o4c', 'config.json'), 'utf-8'));
  });
});

test('hasScope is false for personal with no trusted project, same as local', async () => {
  await withTempDirs(async (globalDir) => {
    const untrusted = new ConfigStore(undefined, globalDir);
    assert.equal(untrusted.hasScope('personal'), false);
  });
});

test('a namespaced ConfigStore reads/writes under that subdirectory at every scope, independent of the unnamespaced instance', async () => {
  await withTempDirs(async (globalDir, projectRoot) => {
    const core = new ConfigStore(projectRoot, globalDir);
    const plugin = new ConfigStore(projectRoot, globalDir, ['plugins', 'infinitecontextwindow']);

    await core.set('local', 'theme', 'light');
    await plugin.set('local', 'indexBatchSize', 500);

    assert.deepEqual(await core.readScope('local'), { theme: 'light' });
    assert.deepEqual(await plugin.readScope('local'), { indexBatchSize: 500 });

    const pluginRaw = await readFile(
      join(projectRoot, '.o4c', 'plugins', 'infinitecontextwindow', 'config.json'),
      'utf-8',
    );
    assert.deepEqual(JSON.parse(pluginRaw), { indexBatchSize: 500 });
  });
});
