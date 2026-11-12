import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigStore } from '../session/configStore.js';
import { baseUrlOf, describeEndpoint, endpointFor, listModels, normalizeUrl, parseEndpoints, PRESETS, saveEndpoint, selectProvider, suggestLocalName, validName } from '../session/endpoints.js';

test('URLs: whatever the user pastes, the base the provider appends /v1/... to', () => {
  assert.equal(normalizeUrl(' https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions/ '), 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
  assert.equal(baseUrlOf('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1'), 'https://bedrock-runtime.us-east-1.amazonaws.com/openai');
  assert.equal(baseUrlOf('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api');
  assert.equal(baseUrlOf('http://box:8080'), 'http://box:8080');
});

test('the Bedrock presets build the URLs AWS documents', () => {
  const runtime = PRESETS.find((p) => p.id === 'bedrock')!;
  const mantle = PRESETS.find((p) => p.id === 'bedrock-mantle')!;
  assert.equal(runtime.url!('eu-west-1'), 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1');
  assert.equal(mantle.url!('us-west-2'), 'https://bedrock-mantle.us-west-2.api.aws/v1');
  assert.equal(runtime.listsModels, false, 'bedrock-runtime has no GET /models');
});

test('parseEndpoints keeps good entries and names every bad one; built-in names never select an endpoint', () => {
  const { endpoints, problems } = parseEndpoints({
    bedrock: { url: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', model: 'openai.gpt-oss-120b-1:0', contextWindow: 131072 },
    local: { url: 'https://x/v1', model: 'm' },
    nourl: { model: 'm' },
    'Bad Name': { url: 'https://x', model: 'm' },
    nomodel: { url: 'https://x' },
  });
  assert.deepEqual(endpoints.map((e) => [e.name, e.baseUrl, e.contextWindow]), [['bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai', 131072]]);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /built-in provider name/);
  assert.equal(endpointFor({ endpoints: { local: { url: 'https://x', model: 'm' } } }, 'local'), undefined);
  assert.equal(endpointFor({ endpoints: { bedrock: { url: 'https://x/v1', model: 'm' } } }, 'bedrock')?.model, 'm');
  assert.deepEqual(parseEndpoints(['x']).problems.length, 1);
  assert.equal(validName('anthropic')?.includes('built-in'), true);
  assert.equal(validName('my-bedrock2'), undefined);
});

test('saveEndpoint writes the endpoint and its key to the global config; selecting also sets provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-endpoints-'));
  const store = new ConfigStore(undefined, dir);
  await store.set('global', 'credentials', { local: 'keep-me' });
  await saveEndpoint(store, { name: 'bedrock', url: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/', model: 'openai.gpt-oss-20b-1:0' }, 'aws-key', false);
  let g = await store.readScope('global');
  assert.deepEqual(g.endpoints, { bedrock: { url: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', model: 'openai.gpt-oss-20b-1:0' } });
  assert.deepEqual(g.credentials, { local: 'keep-me', bedrock: 'aws-key' });
  assert.equal(g.provider, undefined, 'not selected');
  await saveEndpoint(store, { name: 'or', url: 'https://openrouter.ai/api/v1', model: 'x/y' }, undefined, true);
  g = await store.readScope('global');
  assert.equal(g.provider, 'or');
  assert.deepEqual(Object.keys(g.endpoints as object), ['bedrock', 'or']);
  await selectProvider(store, 'local');
  assert.equal((await store.readScope('global')).provider, 'local');
});

test('listModels reads GET <url>/models, adds /v1 when the URL has none, and says nothing on failure', async () => {
  const seen: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(input)} ${(init?.headers as Record<string, string>).Authorization ?? '-'}`);
    return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await listModels('https://openrouter.ai/api/v1', 'k', fake), ['a', 'b']);
  assert.deepEqual(await listModels('http://box:8080', undefined, fake), ['a', 'b']);
  assert.deepEqual(seen, ['https://openrouter.ai/api/v1/models Bearer k', 'http://box:8080/v1/models -']);
  const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  assert.equal(await listModels('https://x/v1', undefined, failing), undefined);
});

test('local AI servers: any number of them, each under its own name, kept as local and named after their host', () => {
  const { endpoints, problems } = parseEndpoints({
    phoebe: { url: 'http://192.168.1.20:8080', model: 'qwen3.8-27b', local: true },
    lmstudio: { url: 'http://localhost:1234/v1', model: 'gemma', local: true },
    openai: { url: 'https://api.openai.com/v1', model: 'gpt-5', local: 'yes' },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(endpoints.map((e) => [e.name, e.baseUrl, e.local]), [
    ['phoebe', 'http://192.168.1.20:8080', true],
    ['lmstudio', 'http://localhost:1234', true],
    ['openai', 'https://api.openai.com', undefined],
  ]);
  assert.equal(describeEndpoint(endpoints[0]), 'phoebe - local server at http://192.168.1.20:8080 (qwen3.8-27b when added)');
  assert.equal(PRESETS[0].id, 'local', 'local servers come first in /endpoint-add');
  assert.equal(suggestLocalName('http://phoebe.lan:8080'), 'phoebe');
  assert.equal(suggestLocalName('http://Big_Box:8080'), 'big-box');
  assert.equal(suggestLocalName('http://192.168.1.20:8080'), 'local-server');
  assert.equal(suggestLocalName('http://localhost:8080'), 'local-server');
  assert.equal(suggestLocalName('http://local:8080'), 'local-server', 'a built-in provider name is never suggested');
});

test('saveEndpoint keeps the local flag', async () => {
  const store = new ConfigStore(undefined, mkdtempSync(join(tmpdir(), 'o4c-ep-local-')));
  await saveEndpoint(store, { name: 'phoebe', url: 'http://10.0.0.5:8080', model: 'qwen', local: true }, undefined, false);
  assert.deepEqual((await store.readScope('global')).endpoints, { phoebe: { url: 'http://10.0.0.5:8080', model: 'qwen', local: true } });
});
