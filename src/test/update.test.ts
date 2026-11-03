import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, compareVersions, describeUpdate, installedVersion } from '../session/update.js';

function fakeFetch(npm: unknown, gh: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes('registry.npmjs.org') ? npm : gh;
    if (body === 404) return new Response('{}', { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test('compareVersions orders releases and puts a prerelease before its release', () => {
  assert.equal(compareVersions('0.1.0', '0.0.9'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
});

test('newer on npm: says so and how to update; same version: up to date; nothing published: says that', async () => {
  const v = installedVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
  const newer = describeUpdate(await checkForUpdate(fakeFetch({ version: '99.0.0' }, { tag_name: 'v98.0.0' }))).join('\n');
  assert.match(newer, /o4c 99\.0\.0 is available\.\n {2}npm: {4}npm install -g @open4coding\/o4c-agent@latest\n {2}binary: https:\/\/github\.com\/Open4Coding\/o4c-agent\/releases\/latest/);
  assert.match(describeUpdate(await checkForUpdate(fakeFetch({ version: v }, 404))).join('\n'), /That is the latest/);
  assert.match(describeUpdate(await checkForUpdate(fakeFetch(404, 404))).join('\n'), /No released version found yet/);
  const broken = describeUpdate(await checkForUpdate(fakeFetch(new Error('offline'), new Error('offline')))).join('\n');
  assert.match(broken, /Could not find out what the latest version is\.\n {2}\(npm: offline\)\n {2}\(GitHub: offline\)/);
});
