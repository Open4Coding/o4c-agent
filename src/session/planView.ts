import { formatPlanNo, type PlanItemRow, type PlanItemStatus, type PlanRow, type PlanStore } from './planStore.js';

/**
 * How a plan reads as text - shared by `update_plan` (what the model sees), `/view-plan` (what
 * the user sees) and the export, so a plan looks the same everywhere it is shown.
 *
 * Layout (brief 0005, Q3): header and summary (or, in the full view, the whole body) first, the
 * checklist LAST - every item, then the current item's checks in a block below it - so the list
 * ends right where the eye is.
 */

const MARK: Record<PlanItemStatus, string> = { open: '[ ]', doing: '[>]', done: '[x]', skipped: '[-]' };

export interface PlanViewOptions {
  /** The whole body instead of the summary. */
  readonly full?: boolean;
}

export function planHeader(plan: PlanRow, items: readonly PlanItemRow[]): string {
  const finished = items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  const kind = plan.kind === 'ultraplan' ? ' (ultraplan)' : '';
  const active = plan.active_session ? ', active' : '';
  return `Plan ${formatPlanNo(plan.number)} ${plan.name}${kind} - ${plan.status}${active}, ${finished} of ${items.length} items finished`;
}

export function formatPlan(plans: PlanStore, plan: PlanRow, options: PlanViewOptions = {}): string[] {
  const items = plans.items(plan.id);
  const lines = [planHeader(plan, items)];
  if (plan.goal) lines.push(`Goal: ${plan.goal}`);
  const text = options.full ? plan.body || plan.summary : plan.summary;
  if (text) lines.push('', ...text.replace(/\r\n/g, '\n').trimEnd().split('\n'));
  lines.push('', ...formatChecklist(plans, plan, items));
  return lines;
}

/** The checklist part alone: all items, then the current item's block. */
export function formatChecklist(plans: PlanStore, plan: PlanRow, items = plans.items(plan.id)): string[] {
  if (items.length === 0) return ['Checklist: (no items yet)'];
  const lines = ['Checklist:'];
  for (const item of items) {
    const [first, ...rest] = item.text.split('\n');
    lines.push(`${MARK[item.status]} ${item.position}. ${first}`);
    // Continuation lines hang under the text, past the mark and number.
    for (const line of rest) lines.push(`${' '.repeat(4 + String(item.position).length + 2)}${line}`);
  }
  const current = plans.currentItem(plan.id);
  if (!current) {
    lines.push('', 'Every item is finished.');
    return lines;
  }
  lines.push('', `Current: item ${current.position} of ${items.length} - ${current.text.split('\n')[0]}`);
  for (const check of current.checks.split('\n').filter(Boolean)) lines.push(`  - ${check}`);
  if (current.notes) lines.push('  Notes:', ...current.notes.split('\n').map((n) => `    ${n}`));
  return lines;
}

const STATUS_WORDS: Record<PlanItemStatus, string> = { open: 'not started', doing: 'in progress', done: 'done', skipped: 'skipped' };

/**
 * One checklist item in full - the level under the checklist in `/view-plan` (plan -> checklist ->
 * item). Everything the row stores, readable: its checks, how it was verified, its notes, and the
 * history tasks that worked on it (`#N`, the numbers `search_history` opens).
 */
export function formatItemDetail(plans: PlanStore, plan: PlanRow, item: PlanItemRow): string[] {
  const count = plans.items(plan.id).length;
  const lines = [`Item ${item.position} of ${count} in plan ${formatPlanNo(plan.number)} - ${MARK[item.status]} ${STATUS_WORDS[item.status]}`, ...item.text.split('\n')];
  const checks = item.checks.split('\n').filter(Boolean);
  if (checks.length > 0) lines.push('Checks:', ...checks.map((c) => `  - ${c}`));
  if (item.verification) lines.push(`Verification: ${item.verification}`);
  if (item.done_at) lines.push(`Done: ${new Date(item.done_at).toISOString().replace('T', ' ').slice(0, 16)}`);
  if (item.notes) lines.push('Notes:', ...item.notes.split('\n').map((n) => `  ${n}`));
  const tasks = plans.itemTasks(item.id);
  lines.push(tasks.length > 0 ? `Worked on in tasks: ${tasks.map((t) => `#${t}`).join(', ')}` : 'Worked on in tasks: none yet');
  return lines;
}

export const PLAN_STATUS_MARKS = MARK;
