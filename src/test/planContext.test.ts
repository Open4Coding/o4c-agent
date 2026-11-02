import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { PLAN_BLOCK_CHARS, planBlock, planContextComponent } from '../session/planContext.js';
import type { PlanStore } from '../session/planStore.js';
import { AgentLoop } from '../agent/loop.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';

/** Brief 0005, Q7 / checklist P8: the active plan's current item rides along with every request. */

async function withPlans(fn: (plans: PlanStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-plancontext-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    await fn(store.plans());
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('planBlock: name, progress, the current item with its checks, the one-item rule; nothing without an active plan', async () => {
  await withPlans(async (plans) => {
    const plan = plans.createPlan({ name: 'Export', items: [{ text: 'plan.md' }, { text: 'checklist.md', checks: 'all items\nmarks' }] });
    assert.equal(planBlock(plans, 's1'), undefined, 'not active');
    plans.activate(plan.id, 's1');
    plans.setItemStatus(plan.id, 1, 'done', { verification: 'opened it' });
    plans.setItemStatus(plan.id, 2, 'doing');
    assert.equal(
      planBlock(plans, 's1'),
      [
        '[o4c plan] Active plan 0001 "Export" - 1 of 2 items finished.',
        'Current item 2 (in progress): checklist.md',
        '  - all items',
        '  - marks',
        'Work on this item only. Use update_plan to start it, and to mark it done with how you verified it.',
      ].join('\n'),
    );
    plans.setItemStatus(plan.id, 2, 'done', { verification: 'ok' });
    assert.match(planBlock(plans, 's1')!, /Every item is finished\./);
    plans.addItem(plan.id, { text: 'x'.repeat(5000) });
    assert.equal(planBlock(plans, 's1')!.length, PLAN_BLOCK_CHARS, 'capped');
  });
});

test('the block is a turn note: stored once, re-sent unchanged, re-noted only when the plan moved (plan 0006 A8)', async () => {
  await withPlans(async (plans) => {
    const plan = plans.createPlan({ name: 'P', items: [{ text: 'step one' }, { text: 'step two' }] });
    plans.activate(plan.id, 's1');
    let enabled = true;
    const component = planContextComponent({ plans, sessionId: 's1', enabled: () => enabled });
    assert.match(component.turnNote!()!, /^\[o4c plan\] Active plan 0001 "P"/);
    assert.equal(component.buildRequest, undefined, 'no per-request projection any more');

    const provider = new EchoProvider();
    const loop = new AgentLoop(provider, [], 'sys');
    loop.registerCore(component);
    await loop.run('one');
    await loop.run('two');
    const notes = () => loop.getEntries().filter((e) => e.sub_type === 'note');
    assert.equal(notes().length, 1, 'unchanged plan: one note for both turns');
    assert.match(provider.requests[1]!.messages[0]!.content, /^one\n\n\[o4c plan\]/, 'it stays where it was first given');
    assert.equal(provider.requests[1]!.messages[2]!.content, 'two');

    plans.setItemStatus(plan.id, 1, 'done', { verification: 'ok' });
    await loop.run('three');
    assert.equal(notes().length, 2);
    assert.match(notes()[1]!.content, /Current item 2/);

    enabled = false;
    assert.equal(component.turnNote!(), undefined, 'none window type: nothing');
    enabled = true;
    plans.park(plan.id);
    assert.equal(component.turnNote!(), undefined, 'no active plan: nothing');
  });
});

class EchoProvider implements LLMProvider {
  readonly name = 'echo';
  requests: CompletionRequest[] = [];
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    return { content: 'ok', toolCalls: [], stopReason: 'end_turn' };
  }
}
