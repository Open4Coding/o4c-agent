import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { HistoryRetrieval } from '../session/retrieval.js';
import { curatedHistory } from '../session/curated.js';
import type { CompletionRequest, CompletionResponse } from '../providers/types.js';

/** NextUp item 23, checklist B6: `curated`'s two calls - queries, then picks - and the budget. */

type Reply = string | Error;

async function withCurated(
  replies: Reply[],
  fn: (ctx: { store: InfiniteContextStore; run: (request: string, budget?: number) => Promise<string | undefined>; calls: CompletionRequest[] }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-curated-test-'));
  const store = new InfiniteContextStore(join(dir, 'history.db'));
  store.ensureSession({ id: 's1', title: 't', started_at: Date.now() });
  const calls: CompletionRequest[] = [];
  const complete = async (request: CompletionRequest): Promise<CompletionResponse> => {
    calls.push(request);
    const reply = replies.shift() ?? '';
    if (reply instanceof Error) throw reply;
    return { content: reply, toolCalls: [], stopReason: 'end_turn' };
  };
  let current: number | undefined;
  const retrieval = new HistoryRetrieval({ store, sessionId: 's1', currentTask: () => current });
  const run = async (request: string, budget?: number) => {
    current = store.startTask({ session_id: 's1', request }).id;
    return curatedHistory({ complete, store, retrieval, currentTask: () => current }, request, budget);
  };
  try {
    await fn({ store, run, calls });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function seed(store: InfiniteContextStore, request: string, answer: string): number {
  const task = store.startTask({ session_id: 's1', request });
  store.setTaskAnswer(task.id, answer);
  store.finishTask(task.id);
  return task.id;
}

test('a fresh history skips both calls entirely', async () => {
  await withCurated([], async ({ run, calls }) => {
    assert.equal(await run('make tetris rotate properly'), undefined);
    assert.equal(calls.length, 0);
  });
});

test('queries, then picks: the picked task is loaded and counted as used; both calls are thinking-off and short', async () => {
  const replies: Reply[] = [];
  await withCurated(replies, async ({ store, run, calls }) => {
    const rotation = seed(store, 'fix tetris rotation near the wall', 'Added wall kicks in tryRotate.');
    seed(store, 'write the README for the installer', 'README written.');
    replies.push('1. tetris rotation\n- wall kicks', `#${rotation}`);

    const text = await run('rotation is broken again next to the wall');
    assert.ok(text);
    assert.match(text!, /^\[o4c history\] Earlier tasks in this project/);
    assert.match(text!, /fix tetris rotation near the wall/);
    assert.match(text!, /Added wall kicks in tryRotate/);
    assert.doesNotMatch(text!, /README/);
    assert.equal(store.getTask(rotation)!.used_count, 1);
    assert.equal(calls.length, 2);
    for (const request of calls) {
      assert.equal(request.thinkLevel, 'nothink');
      assert.ok((request.maxTokens ?? Infinity) <= 200);
      assert.deepEqual(request.tools, []);
    }
    assert.match(calls[1].messages[0].content, new RegExp(`#${rotation} fix tetris rotation near the wall`));
  });
});

test('NONE, an unreadable pick or a failing call all mean no history, never an error', async () => {
  await withCurated(['tetris rotation', 'NONE'], async ({ store, run }) => {
    seed(store, 'fix tetris rotation near the wall', 'Added wall kicks.');
    assert.equal(await run('rotation is broken again'), undefined);
  });
  await withCurated(['tetris rotation', 'the first one looks good'], async ({ store, run }) => {
    seed(store, 'fix tetris rotation near the wall', 'Added wall kicks.');
    assert.equal(await run('rotation is broken again'), undefined);
  });
  await withCurated([new Error('server down')], async ({ store, run }) => {
    seed(store, 'fix tetris rotation near the wall', 'Added wall kicks.');
    assert.equal(await run('rotation is broken again'), undefined);
  });
});

test('the budget: picks are loaded in order until it is spent; the first is cut to fit rather than dropped', async () => {
  const replies: Reply[] = [];
  await withCurated(replies, async ({ store, run }) => {
    const a = seed(store, 'tetris rotation fix one', 'x'.repeat(4000));
    const b = seed(store, 'tetris rotation fix two', 'second answer');
    replies.push('tetris rotation', `#${a}, #${b}`);

    const text = await run('tetris rotation again', 300);
    assert.ok(text);
    assert.match(text!, /cut to fit the budget/);
    assert.doesNotMatch(text!, /tetris rotation fix two/);
    assert.ok(text!.length < 300 * 4 + 400);
  });
});
