import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../session/configStore.js';
import { describeServer, detectServers, roundTrip, saveSetup, SETUP_DONE_KEY } from '../session/setup.js';

function fakeFetch(map: Record<string, { status: number; body?: unknown } | 'down'>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(map).find((k) => url.startsWith(k));
    const r = key ? map[key]! : 'down';
    if (r === 'down') throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
}

test('detectServers: up with its models, a 401 needs a key, a refused port is down, a configured URL is added once', async () => {
  const servers = await detectServers(
    ['http://10.0.0.5:8080/', 'http://127.0.0.1:8080'],
    fakeFetch({
      'http://127.0.0.1:8080': { status: 200, body: { data: [{ id: 'qwen3.8-27b' }] } },
      'http://127.0.0.1:11434': { status: 200, body: { data: [{ id: 'llama3' }, { id: 'phi4' }] } },
      'http://10.0.0.5:8080': { status: 401 },
    }),
  );
  const by = Object.fromEntries(servers.map((s) => [s.url, s]));
  assert.equal(servers.length, 4, 'the duplicate of a candidate is not added twice');
  assert.deepEqual([by['http://127.0.0.1:8080']!.state, by['http://127.0.0.1:8080']!.models], ['up', ['qwen3.8-27b']]);
  assert.equal(by['http://127.0.0.1:1234']!.state, 'down');
  assert.equal(by['http://10.0.0.5:8080']!.state, 'needs-key');
  assert.equal(describeServer(by['http://127.0.0.1:11434']!), 'Ollama at http://127.0.0.1:11434 - model llama3 (+1 more)');
  assert.equal(describeServer(by['http://10.0.0.5:8080']!), 'Configured server at http://10.0.0.5:8080 - up, needs an API key');
});

test('saveSetup writes global config and credentials, and updates a project copy that would shadow them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-setup-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, '.o4c'), { recursive: true });
    writeFileSync(join(project, '.o4c', 'config.json'), JSON.stringify({ baseUrl: 'http://old:8080', other: 1 }));
    const store = new ConfigStore(project, home, [], null);
    await saveSetup(store, { provider: 'local', baseUrl: 'http://new:8080', model: 'm', apiKey: 'secret-key-123' });
    const global = await store.readScope('global');
    assert.deepEqual([global.provider, global.baseUrl, global.model, global[SETUP_DONE_KEY]], ['local', 'http://new:8080', 'm', true]);
    assert.deepEqual(global.credentials, { local: 'secret-key-123' });
    const local = await store.readScope('local');
    assert.equal(local.baseUrl, 'http://new:8080', 'the project snapshot was updated');
    assert.equal(local.provider, undefined, 'keys the project did not have are left to global');
    assert.equal(local.credentials, undefined, 'the key never lands in a project file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('roundTrip reports what the probe says', async () => {
  assert.deepEqual(await roundTrip({ provider: 'local', baseUrl: 'http://x' }, async () => ({ ok: true, detail: 'ping in 1.2 s' })), { ok: true, detail: 'ping in 1.2 s' });
  const down = await roundTrip({ provider: 'local', baseUrl: 'http://127.0.0.1:9' });
  assert.equal(down.ok, false);
});
