import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatModelName,
  formatTokenRate,
  formatCumulativeTokens,
  formatTokenCount,
  formatElapsed,
  formatElapsedCoarse,
  elapsedTickMs,
  renderProgressBar,
  progressBarFilledCells,
} from '../ui/statusBar.js';

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

test('formatElapsedCoarse shows minutes only, for the idle clock', () => {
  assert.equal(formatElapsedCoarse(0), '<1m');
  assert.equal(formatElapsedCoarse(59_000), '<1m');
  assert.equal(formatElapsedCoarse(60_000), '1m');
  assert.equal(formatElapsedCoarse(31 * 60_000 + 57_000), '31m');
  assert.equal(formatElapsedCoarse(69 * 60_000), '1h 9m');
});

test('the clock ticks every second while a turn runs and once a minute at idle', () => {
  assert.equal(elapsedTickMs(true), 1000);
  assert.equal(elapsedTickMs(false), 60_000);
});

test('formatModelName reduces a server model path to the name', () => {
  // The real value from PHOEBE's /v1/models - 50 characters of which only the last 27 identify
  // anything, on a line that already carries five other segments.
  assert.equal(
    formatModelName('/media/sda/models/qwen3.8-27b-Q4_K_M-imatFP16.gguf'),
    'qwen3.8-27b-Q4_K_M-imatFP16',
  );
});

test('formatModelName handles both separators, whichever host it runs on', () => {
  // The path comes from the SERVER, so a Windows client routinely sees POSIX paths - and the
  // reverse is possible with a Windows-hosted llama-server.
  assert.equal(formatModelName('C:\\models\\qwen3.gguf'), 'qwen3');
  assert.equal(formatModelName('/models/qwen3.gguf'), 'qwen3');
});

test('formatModelName leaves a plain model id untouched', () => {
  assert.equal(formatModelName('claude-opus-5'), 'claude-opus-5');
  assert.equal(formatModelName('local'), 'local');
});

test('formatModelName strips other weight extensions too, and never returns nothing', () => {
  assert.equal(formatModelName('/m/model.safetensors'), 'model');
  assert.equal(formatModelName('/m/model.bin'), 'model');
  // A path ending in a separator would otherwise blank the segment, reading as "no model".
  assert.equal(formatModelName('/models/'), '/models/');
  assert.equal(formatModelName(''), '');
});

test('formatTokenRate rounds above 10 and keeps a decimal below', () => {
  // 45.9657 is a real measured value; the difference between 46 and 45.97 is noise on a figure
  // that moves every turn. Bare numbers - the `tks/s` label belongs to the whole token line.
  assert.equal(formatTokenRate(45.9657), '46');
  assert.equal(formatTokenRate(50.39), '50');
  assert.equal(formatTokenRate(9.44), '9.4');
  assert.equal(formatTokenRate(1.2), '1.2');
});

test('formatTokenRate shows nothing rather than a misleading zero', () => {
  // Empty means "not measured yet", which the footer renders as `-`; `0` would read as stalled.
  assert.equal(formatTokenRate(0), '');
  assert.equal(formatTokenRate(-1), '');
  assert.equal(formatTokenRate(Number.NaN), '');
  assert.equal(formatTokenRate(Number.POSITIVE_INFINITY), '');
});

test('formatCumulativeTokens carries a lifetime total up past K', () => {
  // The reason this is not formatTokenCount: a project total reaches millions in a handful of
  // long local runs, and `50000K` is not a readable number.
  assert.equal(formatCumulativeTokens(0), '0');
  assert.equal(formatCumulativeTokens(947), '947');
  assert.equal(formatCumulativeTokens(12_345), '12K');
  assert.equal(formatCumulativeTokens(1_234), '1.2K');
  assert.equal(formatCumulativeTokens(1_234_567), '1.2M');
  assert.equal(formatCumulativeTokens(50_000_000), '50M');
  assert.equal(formatCumulativeTokens(2_500_000_000), '2.5B');
  assert.equal(formatCumulativeTokens(3_000_000_000_000), '3.0T');
});

test('formatCumulativeTokens stays narrow enough for the token line', () => {
  // Three of these share one line with its label, so none may blow out to a raw digit string.
  for (const n of [0, 1, 999, 1_000, 999_999, 1e6, 9.99e8, 1e9, 1e12, 9.9e14]) {
    assert.ok(formatCumulativeTokens(n).length <= 5, `${n} rendered as ${formatCumulativeTokens(n)}`);
  }
});

test('formatCumulativeTokens reports a broken counter as zero, not NaN', () => {
  // A hand-edited or half-written usage.json must not leave `NaN` on screen for every later run.
  assert.equal(formatCumulativeTokens(Number.NaN), '0');
  assert.equal(formatCumulativeTokens(-5), '0');
  assert.equal(formatCumulativeTokens(Number.POSITIVE_INFINITY), '0');
});
