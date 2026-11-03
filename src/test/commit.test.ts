import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanCommitMessage, commitDiff, commitPrompt, runCommit } from '../session/commit.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-commit-test-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: dir, windowsHide: true });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

test('cleanCommitMessage strips fences, think blocks and trailers, and adds the configured trailer', () => {
  const fence = '`'.repeat(3);
  const raw = `<think>hmm</think>${fence}text\nFix the parser\n\nBody line.\n\nCo-Authored-By: Bot <b@x>\n${fence}`;
  assert.equal(cleanCommitMessage(raw), 'Fix the parser\n\nBody line.');
  assert.equal(cleanCommitMessage('Fix it', 'Refs: #12'), 'Fix it\n\nRefs: #12');
});

test('commitDiff: clean tree, then unstaged (stage all), then staged only', () => {
  const dir = repo();
  try {
    assert.deepEqual(commitDiff(dir), { error: 'Nothing to commit - the working tree is clean.' });
    writeFileSync(join(dir, 'a.txt'), 'two');
    writeFileSync(join(dir, 'b.txt'), 'new');
    const all = commitDiff(dir);
    assert.ok(!('error' in all));
    assert.equal(all.staged, false);
    assert.match(all.diff, /\+two/);
    assert.match(all.stat, /b\.txt/);
    assert.match(commitPrompt(all, 'keep it short'), /The user says: keep it short/);
    spawnSync('git', ['add', 'b.txt'], { cwd: dir });
    const st = commitDiff(dir);
    assert.ok(!('error' in st));
    assert.equal(st.staged, true);
    assert.doesNotMatch(st.diff, /\+two/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommit stages everything when asked and commits with the exact message', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'c.txt'), 'x');
    const r = runCommit('Add c\n\nBecause.', true, dir);
    assert.equal(r.error, undefined);
    assert.match(r.hash ?? '', /^[0-9a-f]{4,}$/);
    const msg = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: dir, encoding: 'utf-8' }).stdout.trim();
    assert.equal(msg, 'Add c\n\nBecause.');
    assert.deepEqual(commitDiff(dir), { error: 'Nothing to commit - the working tree is clean.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
