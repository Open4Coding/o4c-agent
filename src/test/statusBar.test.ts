import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokenCount, formatElapsed, renderProgressBar, progressBarFilledCells } from '../ui/statusBar.js';

test('formatTokenCount leaves sub-1000 values as-is', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
});

test('formatTokenCount shows one decimal place under 10K', () => {
  assert.equal(formatTokenCount(1000), '1.0K');
  assert.equal(formatTokenCount(1234), '1.2K');
  assert.equal(formatTokenCount(9999), '10.0K');
});

test('formatTokenCount drops the decimal at 10K and above', () => {
  assert.equal(formatTokenCount(10000), '10K');
  assert.equal(formatTokenCount(131100), '131K');
});

test('formatElapsed shows seconds only under a minute', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(29_000), '29s');
});

test('formatElapsed shows minutes and seconds under an hour', () => {
  assert.equal(formatElapsed(69_000), '1m 9s');
});

test('formatElapsed drops seconds once hours are showing', () => {
  assert.equal(formatElapsed((60 * 69 + 5) * 1000), '1h 9m');
});

test('formatElapsed never goes negative for a slightly-behind clock read', () => {
  assert.equal(formatElapsed(-500), '0s');
});

test('renderProgressBar at 0 and 1 fills correctly', () => {
  assert.equal(renderProgressBar(0, 10), '[░░░░░░░░░░]');
  assert.equal(renderProgressBar(1, 10), '[██████████]');
});

test('renderProgressBar clamps fractions outside [0, 1]', () => {
  assert.equal(renderProgressBar(-0.5, 10), '[░░░░░░░░░░]');
  assert.equal(renderProgressBar(1.5, 10), '[██████████]');
});

test('renderProgressBar at a partial fraction rounds to the nearest cell', () => {
  assert.equal(renderProgressBar(0.78, 10), '[████████░░]');
});

test('progressBarFilledCells agrees with renderProgressBar\'s own fill count', () => {
  for (const fraction of [0, 0.00092, 0.5, 0.78, 1, -0.5, 1.5]) {
    const filled = progressBarFilledCells(fraction, 10);
    const rendered = renderProgressBar(fraction, 10);
    assert.equal(rendered, `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`);
  }
});

test('progressBarFilledCells shows an all-empty bar for a near-zero fraction, not a full-looking one', () => {
  // Regression: 211/229376 tokens, the exact real-world case that surfaced this bug - the whole
  // bar was rendered in one uniform bright color, making the empty cells look nearly as
  // prominent as filled ones even though the fill count itself was already correct (0).
  assert.equal(progressBarFilledCells(211 / 229376, 10), 0);
});
