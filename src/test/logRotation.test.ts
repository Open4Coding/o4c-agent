import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logRotationSettings, pruneRunLogs } from '../session/logRotation.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-30T12:00:00.000Z');

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function makeLogs(dir: string, ages: number[]): string[] {
  return ages.map((ageDays, i) => {
    const s = stamp(NOW - ageDays * DAY - i * 1000);
    writeFileSync(join(dir, `${s}.jsonl`), '{}');
    writeFileSync(join(dir, `${s}.FULLCONTEXT.jsonl`), '{}');
    return s;
  });
}

test('keeps the newest N and anything younger than the day limit; removes both files of an old run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-rot-'));
  try {
    writeFileSync(join(dir, 'lifecycle.jsonl'), '{}');
    writeFileSync(join(dir, 'crash.log'), 'x');
    const stamps = makeLogs(dir, [1, 2, 3, 20, 30, 40]);
    const r = pruneRunLogs(dir, 2, 7, NOW);
    assert.deepEqual(r, { removed: 6, kept: 3 });
    const left = readdirSync(dir);
    for (const s of stamps.slice(0, 3)) assert.ok(left.includes(`${s}.jsonl`) && left.includes(`${s}.FULLCONTEXT.jsonl`));
    for (const s of stamps.slice(3)) assert.equal(existsSync(join(dir, `${s}.jsonl`)), false);
    assert.ok(left.includes('lifecycle.jsonl') && left.includes('crash.log'), 'other files are never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a burst of runs today is all kept, however many (one run per turn)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-rot-'));
  try {
    makeLogs(dir, Array.from({ length: 80 }, () => 0));
    assert.deepEqual(pruneRunLogs(dir, 50, 7, NOW), { removed: 0, kept: 80 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keep 0 turns pruning off; a missing folder is fine; settings come from config with defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-rot-'));
  try {
    makeLogs(dir, [100, 200]);
    assert.deepEqual(pruneRunLogs(dir, 0, 0, NOW), { removed: 0, kept: 0 });
    assert.equal(readdirSync(dir).length, 4);
    assert.deepEqual(pruneRunLogs(join(dir, 'nope'), 50, 7, NOW), { removed: 0, kept: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(logRotationSettings({}), { keep: 50, keepDays: 7 });
  assert.deepEqual(logRotationSettings({ logsToKeep: 10.7, logsKeepDays: 2 }), { keep: 10, keepDays: 2 });
});
