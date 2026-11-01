import type { CoreComponent, RequestBuild } from '../agent/coreSeam.js';
import { currentTurnStart } from '../agent/contextTypeComponent.js';
import { formatPlanNo, type PlanStore } from './planStore.js';

/**
 * The active plan, kept in view - brief 0005, Q7 / checklist P8.
 *
 * While a plan is active in this session, every request carries a small block: the plan's name,
 * the current item, its checks, and one progress line. That is what makes "one item at a time"
 * hold across a long turn and across turns (item 17) without the model having to remember to
 * call `update_plan` first. Folded into the current user message, as the `pointer` hint is (see
 * `contextTypeComponent.ts` for why not an entry of its own), and as a `buildRequest` projection
 * the seam's accounting measures it like everything else sent.
 *
 * Registered after the context window type component, so it adds to whatever that projection
 * kept. Skipped for the `none` type (one-shot answers carry nothing) and before a new message
 * (no current turn to fold into yet).
 */

/** The block's hard cap - brief Q7's "~100-300 tokens, capped". */
export const PLAN_BLOCK_CHARS = 1200;

export interface PlanContextOptions {
  readonly plans: PlanStore;
  readonly sessionId: string;
  /** False for the `none` context window type. Read on every request. */
  readonly enabled: () => boolean;
}

export function planBlock(plans: PlanStore, sessionId: string): string | undefined {
  const plan = plans.activePlan(sessionId);
  if (!plan) return undefined;
  const items = plans.items(plan.id);
  const current = plans.currentItem(plan.id);
  const finished = items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  const lines = [`[o4c plan] Active plan ${formatPlanNo(plan.number)} "${plan.name}" - ${finished} of ${items.length} items finished.`];
  if (current) {
    lines.push(`Current item ${current.position} (${current.status === 'doing' ? 'in progress' : 'not started'}): ${current.text}`);
    for (const check of current.checks.split('\n').filter(Boolean)) lines.push(`  - ${check}`);
    lines.push('Work on this item only. Use update_plan to start it, and to mark it done with how you verified it.');
  } else {
    lines.push('Every item is finished. Tell the user, and suggest closing the plan.');
  }
  const block = lines.join('\n');
  return block.length <= PLAN_BLOCK_CHARS ? block : `${block.slice(0, PLAN_BLOCK_CHARS - 3)}...`;
}

export function planContextComponent(options: PlanContextOptions): CoreComponent {
  return {
    name: 'active-plan',
    buildRequest: ({ entries, beforeNewMessage }: RequestBuild) => {
      if (beforeNewMessage || !options.enabled()) return entries;
      const turn = currentTurnStart(entries);
      if (turn < 0) return entries;
      // Read fresh on every request: an item marked done mid-turn moves the block on with it.
      const block = planBlock(options.plans, options.sessionId);
      if (!block) return entries;
      const current = entries[turn];
      return [...entries.slice(0, turn), { ...current, content: `${current.content}\n\n${block}` }, ...entries.slice(turn + 1)];
    },
  };
}
