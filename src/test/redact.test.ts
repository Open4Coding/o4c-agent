import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { REDACTED, clearSecrets, redactSecrets, registerSecret } from '../session/redact.js';
import { RunLogger } from '../session/runLog.js';
import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { SessionStore } from '../session/sessionStore.js';

/** Design §3.4: o4c's own keys never reach the run logs, history.db or session files. */

const KEY = 'sk-local-0123456789abcdef';

afterEach(() => clearSecrets());

test('redactSecrets: registered values only, short values ignored, JSON-escaped form caught', () => {
  registerSecret(KEY);
  registerSecret('abc');
  registerSecret(undefined);
  registerSecret('quote"key\\value');
  assert.equal(redactSecrets(`key=${KEY} twice ${KEY}`), `key=${REDACTED} twice ${REDACTED}`);
  assert.equal(redactSecrets('abc stays'), 'abc stays');
  assert.equal(redactSecrets(JSON.stringify({ v: 'quote"key\\value' })), `{"v":"${REDACTED}"}`);
});

test('run log, history.db entries and tasks, and session files are written redacted', async () => {
  registerSecret(KEY);
  const dir = await mkdtemp(join(tmpdir(), 'o4c-redact-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    const logger = new RunLogger(dir, undefined, 5);
    await logger.log({ type: 'tool_result', output: `O4C_LOCAL_API_KEY=${KEY}` });
    logger.flush();
    const log = await readFile(logger.getFilePath()!, 'utf-8');
    assert.ok(!log.includes(KEY) && log.includes(REDACTED));

    store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
    const task = store.startTask({ session_id: 's1', request: `use ${KEY}` });
    store.setTaskAnswer(task.id, `answer ${KEY}`);
    store.addTaskNote(task.id, `note ${KEY}`);
    store.addTaskError(task.id, `error ${KEY}`);
    store.insertEntry({ id: 'e1', type: 'ai', sub_type: 'tool_result', content: `env: ${KEY}`, session_id: 's1' } as never, task.id);
    const row = store.getTask(task.id)!;
    for (const field of [row.request, row.answer, row.notes, row.errors, row.title]) assert.ok(!String(field).includes(KEY), String(field));
    const entry = store.getByUid('e1')!;
    assert.ok(!entry.content.includes(KEY));
    assert.equal(entry.redacted, 1);

    const sessions = new SessionStore(dir);
    const id = await sessions.save([{ id: 'x', type: 'user', sub_type: 'input', content: `my key ${KEY}` } as never]);
    const file = await readFile(join(dir, 'sessions', `${id}.json`), 'utf-8').catch(async () => readFile(join(dir, `${id}.json`), 'utf-8'));
    assert.ok(!file.includes(KEY) && file.includes(REDACTED));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
