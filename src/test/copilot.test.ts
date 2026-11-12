import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copilotAccount,
  copilotModels,
  defaultCopilotApi,
  normalizeHost,
  resolveCopilotToken,
  restApiFor,
  sortCopilotModels,
  validHost,
} from '../providers/copilot.js';
import { describeEndpoint, hostedRoute, parseEndpoints, PRESETS } from '../session/endpoints.js';

test('hosts: whatever the user types becomes github.com or <name>.ghe.com, each with its own API hosts', () => {
  assert.equal(normalizeHost(' https://Federal-Aviation-Administration.ghe.com/ '), 'federal-aviation-administration.ghe.com');
  assert.equal(normalizeHost(''), 'github.com');
  assert.equal(normalizeHost('www.github.com'), 'github.com');
  assert.equal(validHost('github.com'), undefined);
  assert.equal(validHost('octo-corp.ghe.com'), undefined);
  assert.match(validHost('evil.example.com') ?? '', /ghe\.com/);
  assert.equal(restApiFor('github.com'), 'https://api.github.com');
  assert.equal(restApiFor('octo.ghe.com'), 'https://api.octo.ghe.com');
  assert.equal(defaultCopilotApi('github.com'), 'https://api.githubcopilot.com');
  assert.equal(defaultCopilotApi('octo.ghe.com'), 'https://copilot-api.octo.ghe.com');
});

test('the token: COPILOT_GITHUB_TOKEN, then the host\'s own variables, then a saved one, then the GitHub CLI login', async () => {
  const gh = async (args: string[]) => (args.join(' ') === 'auth token --hostname octo.ghe.com' ? 'gho_cli' : undefined);
  assert.deepEqual(await resolveCopilotToken('github.com', 'saved', { COPILOT_GITHUB_TOKEN: 'c', GH_TOKEN: 'g' }, gh), { token: 'c', source: 'COPILOT_GITHUB_TOKEN' });
  assert.equal((await resolveCopilotToken('github.com', 'saved', { GITHUB_TOKEN: 'g' }, gh))?.token, 'g');
  // github.com's variables are not sent to an enterprise host, and the other way round.
  assert.equal((await resolveCopilotToken('octo.ghe.com', undefined, { GH_TOKEN: 'g' }, gh))?.token, 'gho_cli');
  assert.equal((await resolveCopilotToken('octo.ghe.com', undefined, { GH_ENTERPRISE_TOKEN: 'e' }, gh))?.token, 'e');
  assert.equal((await resolveCopilotToken('github.com', undefined, { GH_ENTERPRISE_TOKEN: 'e' }, gh)), undefined);
  assert.equal((await resolveCopilotToken('octo.ghe.com', 'saved', {}, gh))?.source, 'the token saved with /endpoint-add');
  assert.match((await resolveCopilotToken('octo.ghe.com', undefined, {}, gh))?.source ?? '', /GitHub CLI login for octo\.ghe\.com/);
});

test('the account names its own API base; when it cannot be read, the documented default is used', async () => {
  let asked = '';
  const ok = (async (input: string | URL | Request) => {
    asked = String(input);
    return Response.json({ copilot_plan: 'business', endpoints: { api: 'https://api.business.githubcopilot.com/' } });
  }) as typeof fetch;
  assert.deepEqual(await copilotAccount('github.com', 't', ok), { api: 'https://api.business.githubcopilot.com', plan: 'business' });
  assert.equal(asked, 'https://api.github.com/copilot_internal/user');
  const denied = (async () => new Response('no', { status: 403 })) as typeof fetch;
  assert.deepEqual(await copilotAccount('octo.ghe.com', 't', denied), { api: 'https://copilot-api.octo.ghe.com' });
  const odd = (async () => Response.json({ endpoints: { api: 'http://plain' } })) as typeof fetch;
  assert.equal((await copilotAccount('github.com', 't', odd)).api, 'https://api.githubcopilot.com');
});

test('models: chat models with tools on Chat Completions are offered; Responses-only and policy-disabled ones are named, not offered', async () => {
  const data = [
    { id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages', '/chat/completions'], capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_prompt_tokens: 200000 } } },
    { id: 'gpt-6.1-sol', supported_endpoints: ['/responses', 'ws:/responses'], capabilities: { type: 'chat', supports: { tool_calls: true } } },
    { id: 'claude-sonnet-5.5', policy: { state: 'disabled' }, supported_endpoints: ['/chat/completions'], capabilities: { type: 'chat', supports: { tool_calls: true } } },
    { id: 'gpt-4.1-2025-04-14', version: 'gpt-4.1-2025-04-14', capabilities: { type: 'chat', supports: { tool_calls: true } } },
    { id: 'gpt-4.1', version: 'gpt-4.1-2025-04-14', model_picker_category: 'versatile', capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_context_window_tokens: 64000 } } },
    { id: 'gpt-4.1', capabilities: { type: 'chat', supports: { tool_calls: true } } },
    { id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } },
    { id: 'no-tools', capabilities: { type: 'chat', supports: {} } },
  ];
  assert.deepEqual(sortCopilotModels(data), {
    // GitHub's picker categories first; the dated snapshot beside gpt-4.1 is left out.
    usable: [{ id: 'gpt-4.1', contextWindow: 64000 }, { id: 'claude-opus-5.5', contextWindow: 200000 }],
    responsesOnly: ['gpt-6.1-sol'],
    disabled: ['claude-sonnet-5.5'],
  });
  let auth = '';
  const f = (async (_: unknown, init?: RequestInit) => {
    auth = (init?.headers as Record<string, string>).Authorization;
    return Response.json({ data });
  }) as typeof fetch;
  assert.equal((await copilotModels('https://api.x', 'tok', f))?.usable.length, 2);
  assert.equal(auth, 'Bearer tok');
  assert.equal(await copilotModels('https://api.x', 'tok', (async () => new Response('', { status: 401 })) as typeof fetch), undefined);
});

test('a Copilot endpoint keeps its host in config, and requests go to <api>/chat/completions with Copilot\'s headers', () => {
  const { endpoints, problems } = parseEndpoints({
    copilot: { url: 'https://api.individual.githubcopilot.com', model: 'gpt-4.1', contextWindow: 64000, copilot: 'github.com' },
    bedrock: { url: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', model: 'm' },
  });
  assert.deepEqual(problems, []);
  const [copilot, bedrock] = endpoints;
  assert.equal(copilot.copilot, 'github.com');
  const route = hostedRoute(copilot);
  assert.equal(route.baseUrl, 'https://api.individual.githubcopilot.com');
  assert.equal(route.chatPath, '/chat/completions');
  assert.equal(route.headers?.['Copilot-Integration-Id'], 'copilot-developer-cli');
  assert.deepEqual(hostedRoute(bedrock), { baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai' });
  assert.equal(describeEndpoint(copilot), 'copilot - gpt-4.1 at GitHub Copilot (github.com)');
  assert.equal(PRESETS.find((p) => p.id === 'copilot')?.copilot, true);
});
