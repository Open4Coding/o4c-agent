import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../session/configStore.js';
import { DEFAULT_STEP_LIMIT, describeStepLimit, parseStepLimit, resolveStepLimit, saveStepLimit, stepLimitIn } from '../session/stepLimit.js';

test('parseStepLimit: whole numbers, 0 and its words for no limit; anything else is refused', () => {
  assert.equal(parseStepLimit('40'), 40);
  assert.equal(parseStepLimit(' 0 '), 0);
  for (const w of ['off', 'OFF', 'none', 'infinite', 'unlimited']) assert.equal(parseStepLimit(w), 0, w);
  for (const bad of ['-1', '2.5', 'ten', '', '1e3']) assert.equal(parseStepLimit(bad), undefined, bad);
  assert.equal(describeStepLimit(0), 'no limit');
  assert.equal(describeStepLimit(25), '25 steps');
  assert.equal(DEFAULT_STEP_LIMIT, 25);
});

test('stepLimitIn: stepLimit wins over the old maxIterations in one scope; the old key alone still counts', () => {
  assert.equal(stepLimitIn({ stepLimit: 50, maxIterations: 10 }), 50);
  assert.equal(stepLimitIn({ maxIterations: 10 }), 10);
  assert.equal(stepLimitIn({ maxIterations: -3 }), 0, 'a negative old value meant no cap, as it did in the loop');
  assert.equal(stepLimitIn({}), undefined);
});

test('the project value wins over the global one; saving drops the old key from that scope', async () => {
  const store = new ConfigStore(mkdtempSync(join(tmpdir(), 'o4c-sl-proj-')), mkdtempSync(join(tmpdir(), 'o4c-sl-glob-')), [], null);
  assert.equal(await resolveStepLimit(store), undefined, 'nothing set: the default applies');
  await store.set('local', 'maxIterations', 40);
  assert.deepEqual(await resolveStepLimit(store), { value: 40, scope: 'local' });
  await saveStepLimit(store, 'global', 0);
  assert.deepEqual(await resolveStepLimit(store), { value: 40, scope: 'local' }, 'a global change is hidden by the project value');
  await saveStepLimit(store, 'local', 60);
  const local = await store.readScope('local');
  assert.equal(local.stepLimit, 60);
  assert.equal('maxIterations' in local, false, 'the old key is gone from the scope written');
  assert.deepEqual(await resolveStepLimit(store), { value: 60, scope: 'local' });
  assert.equal((await store.readScope('global')).stepLimit, 0);
});
