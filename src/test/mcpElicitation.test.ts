import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { elicit, expandHeaders } from '../mcp/elicitation.js';
import { parseServers } from '../mcp/serverConfig.js';
import { McpHost } from '../mcp/host.js';
import { setAskUserHandler } from '../tools/askUser.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcpFixtureServer.mjs');

afterEach(() => setAskUserHandler(undefined));

function asker(answers: (string | undefined)[], asked: string[] = []) {
  return async (q: string, options: string[]) => {
    asked.push(`${q} [${options.join('|')}]`);
    return answers.shift();
  };
}

const form = {
  message: 'Configure the deploy',
  requestedSchema: {
    properties: {
      env: { type: 'string', enum: ['staging', 'prod'], title: 'Environment' },
      replicas: { type: 'integer', description: 'how many' },
      dryRun: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: ['env', 'replicas'],
  },
};

test('a form asks consent, then each field, and converts the answers by type', async () => {
  const asked: string[] = [];
  const r = await elicit('deploy', form, asker(['Answer it', 'prod', '3', 'yes', ''], asked));
  assert.deepEqual(r, { action: 'accept', content: { env: 'prod', replicas: 3, dryRun: true } });
  assert.match(asked[0]!, /The MCP server "deploy" asks for information:\nConfigure the deploy \[Answer it\|Decline\]/);
  assert.match(asked[1]!, /"deploy" - Environment \[staging\|prod\]/);
  assert.match(asked[2]!, /replicas - how many \[\]/);
  assert.match(asked[4]!, /note \(optional - empty to skip\)/);
});

test('decline, cancel, bad numbers and missing required fields; nobody to ask declines', async () => {
  assert.deepEqual(await elicit('s', form, asker(['Decline'])), { action: 'decline' });
  assert.deepEqual(await elicit('s', form, asker([undefined])), { action: 'cancel' });
  assert.deepEqual(await elicit('s', form, asker(['Answer it', 'prod', '2.5'])), { action: 'decline' });
  assert.deepEqual(await elicit('s', form, asker(['Answer it', ''])), { action: 'decline' });
  assert.deepEqual(await elicit('s', form, undefined), { action: 'decline' });
});

test('URL mode shows the link and accepts once the user says it is done', async () => {
  const asked: string[] = [];
  const r = await elicit('auth', { mode: 'url', url: 'https://example.com/login', message: 'Sign in' }, asker(['I have done it'], asked));
  assert.deepEqual(r, { action: 'accept' });
  assert.match(asked[0]!, /open this page:\nhttps:\/\/example\.com\/login\nSign in/);
});

test('header values fill ${VAR} from the environment and report what is missing; config keeps headers', () => {
  assert.deepEqual(expandHeaders({ Authorization: 'Bearer ${TOKEN}', 'X-Team': '${TEAM}-x' }, { TOKEN: 'abc' }), {
    headers: { Authorization: 'Bearer abc', 'X-Team': '-x' },
    missing: ['TEAM'],
  });
  const { servers, problems } = parseServers({ remote: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } });
  assert.deepEqual(problems, []);
  assert.deepEqual(servers[0]!.headers, { Authorization: 'Bearer ${TOKEN}' });
});

test('a real server elicits mid-call, through the ask_user dialog', async () => {
  const { servers } = parseServers({ fixture: { transport: 'stdio', command: process.execPath, args: [FIXTURE], env: { O4C_FIXTURE_MODE: 'elicit' } } });
  const host = await McpHost.start(servers);
  try {
    const greet = host.tools().find((t) => t.name === 'mcp__fixture__greet')!;
    setAskUserHandler(async (_q, options) => (options.length ? options[0] : 'Ada'));
    assert.equal(await greet.execute({}), 'hello Ada');
    setAskUserHandler(undefined);
    assert.equal(await greet.execute({}), 'no greeting (decline)', 'headless: declined');
  } finally {
    await host.shutdown();
  }
});
