import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrefillEchoFilter } from '../providers/prefillEcho.js';

/**
 * Plan 0003 follow-up 3/4. llama-server echoes a prefill back at the head of the stream, and in
 * `full` session view streamed deltas commit into scrollback as they arrive - so without this the
 * cut-off text appears on screen twice. Measured 2026-10-11, 4/4 runs.
 */

function collect(prefill: string, deltas: Array<[string, 'think' | 'text']>): string {
  const out: string[] = [];
  const filter = createPrefillEchoFilter(prefill, (d, k) => out.push(k === 'text' ? d : `<${k}>${d}`));
  for (const [delta, kind] of deltas) filter(delta, kind);
  return out.join('');
}

const PREFILL = 'Here are three facts about the Moon:\n1. The Moon is about';

test('an echo arriving in one delta is suppressed, and the continuation still comes through', () => {
  const shown = collect(PREFILL, [[`${PREFILL} 384,400 km away.`, 'text']]);
  assert.equal(shown, ' 384,400 km away.');
});

test('an echo split across many deltas is suppressed, however the chunk boundaries fall', () => {
  const deltas: Array<[string, 'think' | 'text']> = [];
  for (let i = 0; i < PREFILL.length; i += 7) deltas.push([PREFILL.slice(i, i + 7), 'text']);
  deltas.push([' 384,400 km away.', 'text']);
  assert.equal(collect(PREFILL, deltas), ' 384,400 km away.');
});

test('a chunk that straddles the end of the echo emits only the part past it', () => {
  const straddle = PREFILL.slice(-4) + ' 384,400 km';
  const deltas: Array<[string, 'think' | 'text']> = [
    [PREFILL.slice(0, -4), 'text'],
    [straddle, 'text'],
    [' away.', 'text'],
  ];
  assert.equal(collect(PREFILL, deltas), ' 384,400 km away.');
});

// The safety case: if the server does NOT echo, nothing may be swallowed. Anthropic prefill behaves
// this way, and so would llama-server if its template ever changed.
test('a stream that never matches the prefill passes through untouched, nothing withheld', () => {
  const shown = collect(PREFILL, [
    ['Actually, let me start over. ', 'text'],
    ['The Moon is a satellite.', 'text'],
  ]);
  assert.equal(shown, 'Actually, let me start over. The Moon is a satellite.');
});

test('a stream that matches part of the prefill and then diverges releases what was withheld', () => {
  const partial = PREFILL.slice(0, 20);
  const shown = collect(PREFILL, [
    [partial, 'text'],
    [' something else entirely', 'text'],
  ]);
  assert.equal(shown, `${partial} something else entirely`);
});

test('reasoning deltas pass through and do not disturb the text match', () => {
  const shown = collect(PREFILL, [
    ['pondering', 'think'],
    [PREFILL, 'text'],
    [' 384,400 km away.', 'text'],
  ]);
  assert.equal(shown, '<think>pondering 384,400 km away.');
});

test('everything after the echo passes through, including text identical to the prefill', () => {
  // Once the echo is consumed the filter must get out of the way completely - a model that
  // legitimately repeats itself later is not this filter's business.
  const shown = collect(PREFILL, [
    [PREFILL, 'text'],
    [` and again: ${PREFILL}`, 'text'],
  ]);
  assert.equal(shown, ` and again: ${PREFILL}`);
});

test('an empty prefill-matching stream emits nothing rather than erroring', () => {
  assert.equal(collect(PREFILL, [[PREFILL, 'text']]), '');
});

test('empty deltas are forwarded unchanged and do not end the match early', () => {
  const shown = collect(PREFILL, [
    [PREFILL.slice(0, 10), 'text'],
    ['', 'text'],
    [PREFILL.slice(10), 'text'],
    [' tail', 'text'],
  ]);
  assert.equal(shown, ' tail');
});
