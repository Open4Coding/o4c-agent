import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultProvider } from '../session/providerDefault.js';

/** Checklist 0006 item 0.5: a bare `o4c` uses the configured local default. */

test('config provider wins; any local config means local; only an Anthropic key means anthropic; nothing means local', () => {
  assert.equal(defaultProvider({ provider: 'mock' }, { ANTHROPIC_API_KEY: 'k' }), 'mock');
  assert.equal(defaultProvider({ baseUrl: 'http://x:8080' }, { ANTHROPIC_API_KEY: 'k' }), 'local');
  assert.equal(defaultProvider({ localApiKey: 'k' }, {}), 'local');
  assert.equal(defaultProvider({}, { O4C_LOCAL_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }), 'local');
  assert.equal(defaultProvider({}, { ANTHROPIC_API_KEY: 'k' }), 'anthropic');
  assert.equal(defaultProvider({}, {}), 'local');
  assert.equal(defaultProvider({ provider: '' }, {}), 'local');
});
