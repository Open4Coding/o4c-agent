import type { Tool } from '../tools/types.js';
import { PlanRuleError, formatPlanNo, type PlanItemStatus, type PlanRow, type PlanStore } from './planStore.js';
import { formatPlan } from './planView.js';

/**
 * `update_plan` - the model's side of a plan (brief 0005, decision 5 / checklist P3).
 *
 * One tool with an `action`, for the same reason `search_history` has two verbs on one tool: a
 * model choosing between many small tools chooses badly. Every rule (done needs a verification
 * note, one item doing at a time) is the store's, so the model gets the same refusal the user's
 * picker would - as a plain sentence it can act on, never a thrown error.
 *
 * Not `mutating`: it changes plan bookkeeping, not files or the system. A `done` is signed off by
 * the user in every mode but Auto (brief, Q5) - `needsSignOff`, applied by `classifyToolAccess`.
 */

export interface PlanToolOptions {
  readonly plans: PlanStore;
  readonly sessionId: string;
  /** The history task running now, linked to every item the model starts, finishes or notes. */
  readonly currentTask: () => number | undefined;
}

const STATUS_ACTIONS: Record<string, PlanItemStatus> = { start: 'doing', done: 'done', skip: 'skipped', reopen: 'open' };

export function createPlanTool(options: PlanToolOptions): Tool {
  const { plans } = options;
  return {
    name: 'update_plan',
    description:
      'Read and work through the plan for this project. Work one item at a time: {"action": "start", "item": N} ' +
      'before working on it, then {"action": "done", "item": N, "verification": "what you ran or checked, and the result"}. ' +
      'Other actions: "show", "skip", "reopen", "note" (with "note"), "add" (with "text", optional "after" and "checks"), ' +
      '"remove", "move" (with "to"), "reword" (with "text", optional "checks"). ' +
      'Uses the active plan unless "plan" names another by number.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'start', 'done', 'skip', 'reopen', 'note', 'add', 'remove', 'move', 'reword'],
        },
        plan: { type: 'number', description: 'Plan number, e.g. 5 for plan 0005. Defaults to the active plan.' },
        item: { type: 'number', description: 'Item number in the checklist (1-based).' },
        verification: { type: 'string', description: 'Required for "done": what you ran or checked, and the result.' },
        note: { type: 'string', description: 'A note to keep on the item.' },
        text: { type: 'string', description: 'Item text, for "add" and "reword".' },
        checks: { type: 'string', description: 'The item\'s sub-checks, one per line.' },
        after: { type: 'number', description: 'For "add": the item to insert after (0 = first). Defaults to last.' },
        to: { type: 'number', description: 'For "move": the new position.' },
      },
      required: ['action'],
    },
    // Q5: finishing an item follows the mode - Auto moves on by itself, every other mode asks.
    needsSignOff: (input) => input.action === 'done',
    async execute(input) {
      const action = typeof input.action === 'string' ? input.action : 'show';
      const plan = resolvePlan(plans, options.sessionId, input.plan);
      if (typeof plan === 'string') return plan;
      const item = typeof input.item === 'number' ? input.item : undefined;
      const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
      const show = (lead: string) => [lead, '', ...formatPlan(plans, plans.getPlan(plan.id)!)].join('\n');
      const link = (position: number) => {
        const task = options.currentTask();
        if (task !== undefined) plans.linkTask(plan.id, position, task);
      };

      try {
        if (action === 'show') return formatPlan(plans, plan).join('\n');
        if (action in STATUS_ACTIONS) {
          if (item === undefined) return `"${action}" needs "item": the item's number.`;
          plans.setItemStatus(plan.id, item, STATUS_ACTIONS[action], { verification: text('verification'), note: text('note') });
          link(item);
          return show(`Item ${item} is now ${STATUS_ACTIONS[action]}.`);
        }
        if (action === 'note') {
          if (item === undefined || !text('note')) return '"note" needs "item" and "note".';
          plans.addItemNote(plan.id, item, text('note')!);
          link(item);
          return `Noted on item ${item}.`;
        }
        if (action === 'add') {
          if (!text('text')?.trim()) return '"add" needs "text".';
          const after = typeof input.after === 'number' ? input.after : undefined;
          const position = plans.addItem(plan.id, { text: text('text')!, checks: text('checks') }, after);
          return show(`Added as item ${position}.`);
        }
        if (action === 'remove') {
          if (item === undefined) return '"remove" needs "item".';
          plans.removeItem(plan.id, item);
          return show(`Removed item ${item}; the items after it moved up.`);
        }
        if (action === 'move') {
          if (item === undefined || typeof input.to !== 'number') return '"move" needs "item" and "to".';
          plans.moveItem(plan.id, item, input.to);
          return show(`Moved item ${item}.`);
        }
        if (action === 'reword') {
          if (item === undefined || !text('text')) return '"reword" needs "item" and "text".';
          plans.rewordItem(plan.id, item, text('text')!, text('checks'));
          return show(`Reworded item ${item}.`);
        }
        return `Unknown action "${action}".`;
      } catch (err) {
        if (err instanceof PlanRuleError) return err.message;
        throw err;
      }
    },
  };
}

/** The plan a call means: the one named, else the session's active plan, else the only open one. */
function resolvePlan(plans: PlanStore, sessionId: string, requested: unknown): PlanRow | string {
  if (typeof requested === 'number') {
    return plans.getPlanByNumber(requested) ?? `There is no plan ${formatPlanNo(requested)}. ${listing(plans)}`;
  }
  const active = plans.activePlan(sessionId);
  if (active) return active;
  const open = plans.listPlans().filter((p) => p.status === 'open');
  if (open.length === 1) return open[0];
  return `No plan is active. ${listing(plans)}`;
}

function listing(plans: PlanStore): string {
  const all = plans.listPlans();
  if (all.length === 0) return 'There are no plans yet.';
  return `Name one with "plan": ${all.map((p) => `${p.number} (${p.name})`).join(', ')}.`;
}
