import { formatPlanNo, type PlanRow, type PlanStore } from '../session/planStore.js';
import { PLAN_STATUS_MARKS, planHeader } from '../session/planView.js';

/**
 * `/view-plan`'s two dropdowns - brief 0005, decision 4 / checklist P7. Pure row builders, so the
 * wording is testable without rendering; App.tsx shows them with the generic choice picker.
 *
 * Step 1 picks a plan (newest first). Step 2 picks what to do with it, "View" first so the common
 * case is Enter, Enter. The full view is the next row - one keypress away (Q3).
 */

export interface ChoiceRow<K extends string = string> {
  readonly key: K;
  readonly label: string;
}

export function planPickerRows(plans: PlanStore): ChoiceRow[] {
  return plans.listPlans().map((plan) => {
    const items = plans.items(plan.id);
    const summary = plan.summary ? ` - ${oneLine(plan.summary, 120)}` : '';
    // planHeader starts "Plan 0005 Name ..."; the row drops the word "Plan", the list title says it.
    return { key: String(plan.id), label: `${planHeader(plan, items).replace(/^Plan /, '')}${summary}` };
  });
}

export type PlanAction = 'view' | 'full' | 'activate' | 'park' | 'export' | 'edit';

export function planActionRows(plan: PlanRow, sessionId: string): ChoiceRow<PlanAction>[] {
  const rows: ChoiceRow<PlanAction>[] = [
    { key: 'view', label: 'View - summary, then the checklist' },
    { key: 'full', label: 'View full - the whole plan, then the checklist' },
  ];
  if (plan.active_session === sessionId) {
    rows.push({ key: 'park', label: 'Park - stop sending it with every request; it stays saved' });
  } else {
    rows.push({ key: 'activate', label: 'Make active - o4c keeps it in view while it works (one active plan at a time)' });
  }
  rows.push({ key: 'edit', label: 'Edit items - reword, move, remove or add checklist items, no model call' });
  rows.push({ key: 'export', label: 'Export - write it to .o4c/plans/ as .plan.md + .checklist.md, for git and editors (a snapshot)' });
  return rows;
}

/** Edit items, step 1: which item - every item with its mark, plus adding one at the end. */
export function planItemRows(plans: PlanStore, plan: PlanRow): ChoiceRow[] {
  const rows: ChoiceRow[] = plans.items(plan.id).map((item) => ({
    key: String(item.position),
    label: `${PLAN_STATUS_MARKS[item.status]} ${item.position}. ${oneLine(item.text, 160)}`,
  }));
  rows.push({ key: 'end', label: '+ Add an item at the end' });
  return rows;
}

export type PlanItemOp = 'reword' | 'up' | 'down' | 'remove' | 'add';

/** Edit items, step 2: what to do with item `position` of `count`. Moves that cannot happen are left out. */
export function planItemOpRows(position: number, count: number): ChoiceRow<PlanItemOp>[] {
  const rows: ChoiceRow<PlanItemOp>[] = [{ key: 'reword', label: 'Reword - edit its text in the input box, then Enter' }];
  if (position > 1) rows.push({ key: 'up', label: 'Move up' });
  if (position < count) rows.push({ key: 'down', label: 'Move down' });
  rows.push({ key: 'remove', label: 'Remove - the items after it move up' });
  rows.push({ key: 'add', label: 'Add an item after this one - type it in the input box, then Enter' });
  return rows;
}

/**
 * The hidden commands Reword and Add put in the input box: `/plan-reword <plan> <item> <text>`
 * and `/plan-add <plan> <after> <text>`. Typed by o4c, finished by the user - the text is the part
 * the dropdown cannot collect. Returns undefined for anything that is not one.
 */
export function parsePlanEditCommand(input: string): { op: 'reword' | 'add'; plan: number; item: number; text: string } | undefined {
  const match = /^\/plan-(reword|add)\s+(\d+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  return { op: match[1] as 'reword' | 'add', plan: Number(match[2]), item: Number(match[3]), text: (match[4] ?? '').trim() };
}

export function planActionTitle(plan: PlanRow): string {
  return `Plan ${formatPlanNo(plan.number)} ${plan.name} (↑/↓ to choose, Enter to select, Esc to cancel):`;
}

/**
 * What `/plans` prints once plans live in SQLite (P11): every plan, newest first, plus any file in
 * `.o4c/plans/` that the import could not read as a plan - reported, not hidden, as before.
 */
export function plansListing(plans: PlanStore, unrecognised: readonly string[], imported: readonly string[]): string[] {
  const rows = planPickerRows(plans);
  const lines: string[] = [];
  if (imported.length > 0) lines.push(`Imported from .o4c/plans/: ${imported.join(', ')}`, '');
  if (rows.length === 0) {
    lines.push('No plans yet. Make one with /plan <goal> (or /ultraplan <goal> to research first).');
  } else {
    lines.push('Plans, newest first:', ...rows.map((r) => `  ${r.label}`), '', 'Open one with /view-plan.');
  }
  if (unrecognised.length > 0) {
    lines.push('', 'In .o4c/plans/ but not plan files (expected NNNN.Name.plan.md / .checklist.md):', ...unrecognised.map((n) => `  ${n}`));
  }
  return lines;
}

export const PLAN_PICKER_TITLE = 'Choose a plan (↑/↓ to choose, Enter to select, Esc to cancel):';

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}
