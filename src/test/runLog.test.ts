import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RunLogger, createProviderCallLogger } from '../session/runLog.js';

/** Design §3.7: RunLogger's write queue - the fix for interleaved, corrupted log lines. */

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-runlog-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function lines(text: string): Array<Record<string, unknown>> {
  return text.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('1,000 concurrent entries, some of them 1 MB, land as 1,000 intact lines in order', async () => {
  await withDir(async (dir) => {
    const logger = new RunLogger(dir, undefined, 5);
    const big = 'x'.repeat(1024 * 1024);
    await Promise.all(Array.from({ length: 1000 }, (_, i) => logger.log({ i, body: i % 100 === 0 ? big : 'small' })));
    logger.flush();
    const parsed = lines(await readFile(logger.getFilePath()!, 'utf-8'));
    assert.equal(parsed.length, 1000);
    assert.deepEqual(parsed.map((p) => p.i), Array.from({ length: 1000 }, (_, i) => i));
    assert.equal((parsed[100]!.body as string).length, big.length);
  });
});

test('entries are written by the drain timer without an explicit flush', async () => {
  await withDir(async (dir) => {
    const logger = new RunLogger(dir, 'FULLCONTEXT', 5);
    void logger.log({ type: 'a' });
    assert.equal(logger.getFilePath(), undefined, 'nothing written yet - only queued');
    await new Promise((r) => setTimeout(r, 50));
    assert.match(logger.getFilePath()!, /\.FULLCONTEXT\.jsonl$/);
    assert.equal(lines(await readFile(logger.getFilePath()!, 'utf-8'))[0]!.type, 'a');
  });
});

test('an entry that cannot be serialised becomes a marker line; flush is idempotent', async () => {
  await withDir(async (dir) => {
    const logger = new RunLogger(dir, undefined, 5);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await logger.log({ type: 'bad', circular });
    await logger.log({ type: 'good' });
    logger.flush();
    logger.flush();
    const parsed = lines(await readFile(logger.getFilePath()!, 'utf-8'));
    assert.deepEqual(parsed.map((p) => p.type), ['log_write_failed', 'good']);
  });
});

test('provider-call logger: full first call, deltas after (with system prompt or tools only when changed), full again after a compaction', async () => {
  await withDir(async (dir) => {
    const logger = new RunLogger(dir, 'FULLCONTEXT', 5);
    const log = createProviderCallLogger(logger);
    const tool = { name: 't', description: 'd', inputSchema: {} };
    const response = { content: 'ok', toolCalls: [], stopReason: 'end_turn' as const };
    const m = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    log({ request: { systemPrompt: 's', messages: m(1), tools: [] }, response });
    log({ request: { systemPrompt: 's', messages: m(3), tools: [] }, response });
    log({ request: { systemPrompt: 's2', messages: m(4), tools: [tool] }, response });
    log({ request: { systemPrompt: 's2', messages: m(2), tools: [tool] }, response });
    logger.flush();
    const rows = lines(await readFile(logger.getFilePath()!, 'utf-8'));
    assert.deepEqual(rows.map((r) => r.type), ['provider_call', 'provider_call_delta', 'provider_call_delta', 'provider_call']);
    assert.equal((rows[1]!.messages as unknown[]).length, 2);
    assert.ok(!('systemPrompt' in rows[1]!) && !('tools' in rows[1]!));
    assert.equal(rows[2]!.systemPrompt, 's2');
    assert.deepEqual(rows[2]!.tools, [tool]);
  });
});
