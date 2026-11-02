import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeSampling, samplingFor } from '../agent/sampling.js';

/** Plan 0006 A18: sampling profiles by model and think level. */

test('Qwen gets the model card profile per level; unknown models keep server defaults; config overrides', () => {
  assert.deepEqual(samplingFor('qwen3.8-27b-Q4_K_M', 'med'), { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1.0 });
  assert.equal(samplingFor('qwen3.8-27b', 'nothink')?.temperature, 0.7);
  assert.equal(samplingFor('qwen3.8-27b', 'nothink')?.presence_penalty, undefined, 'dropped: measured 17% decode cost');
  assert.equal(samplingFor('llama-3-70b', 'med'), undefined);
  assert.equal(samplingFor(undefined, 'med'), undefined);
  assert.deepEqual(samplingFor('llama-3-70b', 'med', { thinking: { temperature: 0.2 } }), { temperature: 0.2 });
  assert.equal(describeSampling(undefined), 'server defaults');
  assert.equal(describeSampling({ temperature: 0.7, top_k: 20 }), 'temperature 0.7, top_k 20');
});
