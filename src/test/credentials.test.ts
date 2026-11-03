import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../session/configStore.js';
import { loadCredentials, resolveCredential } from '../session/credentials.js';
import { parseProviderSpecs } from '../providers/factory.js';

test('resolveCredential takes a value, an env variable, or the first line of a file', () => {
  assert.equal(resolveCredential('  abc  '), 'abc');
  assert.equal(resolveCredential({ env: 'K' }, { K: 'from-env' }), 'from-env');
  assert.equal(resolveCredential({ env: 'MISSING' }, {}), undefined);
  assert.equal(resolveCredential({ file: '/keys/x' }, {}, (p) => (p === '/keys/x' ? 'line1\nline2' : '')), 'line1');
  assert.equal(resolveCredential({ file: '/nope' }, {}, () => { throw new Error('ENOENT'); }), undefined);
  assert.equal(resolveCredential(42), undefined);
});

test('loadCredentials reads global and personal (personal wins), ignores shared files, reports dead names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-creds-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, '.o4c'), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ credentials: { local: 'global-key', anthropic: { env: 'CLAUDE_K' }, dead: { env: 'NOT_SET' } } }));
    writeFileSync(join(project, '.o4c', 'config.local.json'), JSON.stringify({ credentials: { local: 'personal-key' } }));
    writeFileSync(join(project, '.o4c', 'config.json'), JSON.stringify({ credentials: { local: 'committed-key' } }));
    const c = await loadCredentials(new ConfigStore(project, home, [], null), { CLAUDE_K: 'ck' });
    assert.deepEqual(c.values, { local: 'personal-key', anthropic: 'ck' });
    assert.equal(c.problems.length, 2);
    assert.match(c.problems.join('\n'), /in the local config\.json is ignored/);
    assert.match(c.problems.join('\n'), /credential "dead" \(global\) resolves to nothing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fallbackChain entry can name a credential', () => {
  const { specs } = parseProviderSpecs([{ provider: 'local', baseUrl: 'http://x', credential: 'work-box' }]);
  assert.equal(specs[0]!.credential, 'work-box');
});
