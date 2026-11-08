import test from 'node:test';
import assert from 'node:assert/strict';
import { addPhases, formatPhases, RequestPhases } from '../agent/phaseTimer.js';

test('a request that thinks then answers splits into prefill, think and answer, with the server prefill winning', () => {
  const r = new RequestPhases(0);
  r.output('think', 1_000);
  r.output('think', 5_000);
  r.output('text', 6_000);
  r.output('text', 8_000);
  r.end(9_000, 800);
  assert.deepEqual(r.times(99_999), { prefillMs: 800, thinkMs: 5_000, answerMs: 3_000 });
});

test('while it runs, the open phase grows with the clock; without a server figure prefill is the wait for output', () => {
  const r = new RequestPhases(0);
  assert.deepEqual(r.times(2_000), { prefillMs: 2_000, thinkMs: 0, answerMs: 0 });
  r.output('think', 2_500);
  assert.deepEqual(r.times(4_500), { prefillMs: 2_500, thinkMs: 2_000, answerMs: 0 });
  r.output('text', 5_000);
  assert.deepEqual(r.times(7_000), { prefillMs: 2_500, thinkMs: 2_500, answerMs: 2_000 });
});

test('no thinking is all answer, and a request that ends on a think stops the think at its last token', () => {
  const plain = new RequestPhases(0);
  plain.output('text', 1_000);
  plain.end(4_000);
  assert.deepEqual(plain.times(10_000), { prefillMs: 1_000, thinkMs: 0, answerMs: 3_000 });

  const cut = new RequestPhases(0);
  cut.output('think', 1_000);
  cut.output('think', 3_000);
  cut.end(3_500);
  assert.deepEqual(cut.times(10_000), { prefillMs: 1_000, thinkMs: 2_000, answerMs: 500 });
});

test('a turn sums its requests, and the line switches to minutes past 60 s', () => {
  const sum = addPhases({ prefillMs: 4_200, thinkMs: 30_000, answerMs: 1_000 }, { prefillMs: 0, thinkMs: 8_000, answerMs: 5_100 });
  assert.equal(formatPhases(sum), 'prefill 4.2s · think 38.0s · answer 6.1s');
  assert.equal(formatPhases({ prefillMs: 59_960, thinkMs: 125_400, answerMs: 0 }), 'prefill 1m00s · think 2m05s · answer 0.0s');
});
