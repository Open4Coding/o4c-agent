import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session/sessionStore.js';
import type { ContextEntry } from '../agent/contextEntry.js';
import { cleanTitle, forkSession, lastErrorReport, latestSession, recordLastError, startupLine, titlePrompt } from '../session/sessionExtras.js';

function entry(content: string): ContextEntry {
  return { type: 'user', sub_type: 'input', content } as unknown as ContextEntry;
}

test('latestSession is the newest saved session; forkSession copies under a new id and leaves the original', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-extras-'));
  try {
    const store = new SessionStore(dir);
    assert.equal(await latestSession(store), undefined);
    const a = await store.save([entry('first task')]);
    const b = await store.save([entry('second task')]);
    assert.equal((await latestSession(store))?.id, b);
    const fork = await forkSession(store, [entry('second task'), entry('more')], ['second task'], 'second task');
    assert.notEqual(fork.id, b);
    assert.equal(fork.title, 'second task (fork)');
    const manifest = await store.readManifest();
    assert.deepEqual(manifest.map((m) => m.id).sort(), [a, b, fork.id].sort());
    assert.equal((await store.load(b))?.entries?.length, 1, 'the original is unchanged');
    assert.equal((await store.load(fork.id))?.entries?.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startupLine names the server state, model, context and the last session', () => {
  const last = { id: 'x', title: 'fix the parser', createdAt: '', updatedAt: '', messageCount: 2 };
  assert.equal(
    startupLine({ provider: 'local', status: 'up', model: 'qwen', contextWindow: 229376, last }),
    'server up · model qwen · context 229,376; last session "fix the parser" (o4c --continue, or /resume)',
  );
  assert.equal(startupLine({ provider: 'anthropic', status: 'up' }), 'anthropic');
  assert.equal(startupLine({ provider: 'phoebe', local: true, status: 'down' }), 'phoebe server down');
});

test('lastErrorReport shows the recorded error and the end of crash.log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-lasterr-'));
  try {
    assert.deepEqual(lastErrorReport(dir), ['No request has failed yet.']);
    recordLastError(new Error('HTTP 500 from server'), dir);
    appendFileSync(join(dir, 'crash.log'), `${JSON.stringify({ ts: 't1', type: 'uncaughtException', message: 'boom' })}\nnot json\n`);
    const r = lastErrorReport(dir).join('\n');
    assert.match(r, /Last error \(.+\):\n {2}HTTP 500 from server/);
    assert.match(r, /crash\.log \(last 2/);
    assert.match(r, /t1 uncaughtException: boom/);
    assert.match(r, / {2}not json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanTitle takes the first line without quotes or think text, and rejects nonsense', () => {
  assert.equal(cleanTitle('<think>hmm</think>\n"Fix the flaky parser test."\nextra'), 'Fix the flaky parser test');
  assert.equal(cleanTitle('**Refactor login**'), 'Refactor login');
  assert.equal(cleanTitle(''), undefined);
  assert.equal(cleanTitle('x'.repeat(100)), undefined);
  assert.match(titlePrompt('hello'), /3 to 7 words[\s\S]*hello$/);
});
