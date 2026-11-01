import { formatPlanNo, type PlanRow, type PlanStore } from '../session/planStore.js';
import { planHeader } from '../session/planView.js';

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

export type PlanAction = 'view' | 'full' | 'activate' | 'park';

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
  return rows;
}

export function planActionTitle(plan: PlanRow): string {
  return `Plan ${formatPlanNo(plan.number)} ${plan.name} (↑/↓ to choose, Enter to select, Esc to cancel):`;
}

export const PLAN_PICKER_TITLE = 'Choose a plan (↑/↓ to choose, Enter to select, Esc to cancel):';

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}
