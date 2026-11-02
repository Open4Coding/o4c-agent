import type { CoreComponent } from '../agent/coreSeam.js';
import { formatPlanNo, type PlanStore } from './planStore.js';

/**
 * The active plan, kept in view - brief 0005, Q7 / checklist P8.
 *
 * While a plan is active in this session, every request carries a small block: the plan's name,
 * the current item, its checks, and one progress line. That is what makes "one item at a time"
 * hold across a long turn and across turns (item 17) without the model having to remember to
 * call `update_plan` first.
 *
 * Given as a turn note (plan 0006 A8): stored in history once per change, at the start of a turn,
 * folded into that turn's user message. Until A8 it was re-folded into the current user message
 * on every request, so the plan moving on mid-turn re-processed the whole turn, and every new turn
 * re-processed the previous one when the block moved off it. Mid-turn the model needs no note: the
 * `update_plan` result it just got already says what the current item is now. Skipped for the
 * `none` context window type (one-shot answers carry nothing).
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
    turnNote: () => (options.enabled() ? planBlock(options.plans, options.sessionId) : undefined),
  };
}
