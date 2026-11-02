import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historySearchAllowed } from '../agent/contextWindowType.js';

/** Plan 0006 D11: model-initiated history search - on, off, or following the context window type. */

test('auto follows the type (off for the default floating); on and off override it', () => {
  const type = (t: string) => ({ type: t }) as Parameters<typeof historySearchAllowed>[0];
  assert.equal(historySearchAllowed(type('floating'), undefined), false, 'the default is off');
  assert.equal(historySearchAllowed(type('pointer'), undefined), true);
  assert.equal(historySearchAllowed(type('curated'), undefined), true);
  assert.equal(historySearchAllowed(type('floating'), true), true);
  assert.equal(historySearchAllowed(type('pointer'), false), false);
});

test('with search off, the pointer hint does not point at a tool the model lacks', async () => {
  const { HistoryRetrieval } = await import('../session/retrieval.js');
  const retrieval = new HistoryRetrieval({ store: {} as never, sessionId: 's', currentTask: () => undefined, searchAllowed: () => false });
  assert.equal(retrieval.pointerHint('anything'), undefined);
});
