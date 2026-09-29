import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSplashText } from '../ui/splash.js';

test('buildSplashText includes the word-mark, location, provider/model, and mode', () => {
  const text = buildSplashText({
    location: 'D:\\some\\project',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    modeLabel: 'Manual',
  });

  assert.match(text, /█████/); // the word-mark itself
  assert.match(text, /D:\\some\\project/);
  assert.match(text, /anthropic · claude-sonnet-5/);
  assert.match(text, /Mode: Manual/);
});

test('baseUrl is included when given (local provider)', () => {
  const text = buildSplashText({
    location: '/tmp/project',
    provider: 'local',
    model: 'qwen3.8-27b',
    baseUrl: 'http://192.168.0.128:8080',
    modeLabel: 'Auto',
  });

  assert.match(text, /local · qwen3\.8-27b · http:\/\/192\.168\.0\.128:8080/);
});

test('baseUrl is omitted entirely when not given (anthropic)', () => {
  const text = buildSplashText({
    location: '/tmp/project',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    modeLabel: 'Manual',
  });

  assert.doesNotMatch(text, /·.*·/); // never a second separator when there's no baseUrl segment
});
