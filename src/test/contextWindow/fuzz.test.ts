import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstViolation, generateCase, shrink, type FuzzCase } from './fuzz.js';

test('the same seed and window generate the same case', () => {
  assert.deepEqual(generateCase(42, 57344), generateCase(42, 57344));
  assert.notDeepEqual(generateCase(42, 57344), generateCase(43, 57344));
});

test('the same case fails the same way on every run', async () => {
  const c = generateCase(9, 4096);
  assert.equal(await firstViolation(c), await firstViolation(c));
});

test('shrinking reduces a planted failure to its minimum', async () => {
  const start: FuzzCase = {
    seed: 0,
    window: 4096,
    drift: 1.5,
    summarizer: 'huge',
    preload: { pairs: 3, tokensEach: 10 },
    turns: [
      { prompt: 'long', abortable: false, rounds: Array.from({ length: 25 }, () => ({ responseTokens: 40 })) },
      { prompt: 'short', abortable: false, rounds: [{ responseTokens: 5 }] },
    ],
  };
  const minimal = await shrink(start, (c) => c.turns.some((t) => t.rounds.length >= 6));
  assert.equal(minimal.turns.length, 1);
  assert.equal(minimal.turns[0].rounds.length, 6);
  assert.equal(minimal.drift, 1);
  assert.equal(minimal.summarizer, 'ok');
  assert.equal(minimal.preload, undefined);
  assert.deepEqual(minimal.turns[0].rounds[0], { responseTokens: 0 });
});
