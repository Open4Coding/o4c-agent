import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatPlanNo, type PlanItemStatus, type PlanRow, type PlanStore } from './planStore.js';

/**
 * Export a plan as `.o4c/plans/NNNN.Name.plan.md` + `.checklist.md` - brief 0005, Q1 / P9.
 *
 * For git and editors. SQLite stays the source of truth: the files are a snapshot, overwritten by
 * the next export, and never read back - an exported plan records the file stem in `source_file`,
 * which is exactly what makes the startup import (P2) skip it rather than import a second copy.
 * A plan that came in by import keeps its original stem, so its export lands on the same files.
 */

export interface PlanExportResult {
  readonly planFile: string;
  readonly checklistFile: string;
}

const STATUS_LINE: Record<PlanItemStatus, (text: string) => string> = {
  open: (t) => `- [ ] ${t}`,
  doing: (t) => `- [ ] ${t} (in progress)`,
  done: (t) => `- [x] ${t}`,
  skipped: (t) => `- [-] ${t} (skipped)`,
};

export async function exportPlan(projectRoot: string, plans: PlanStore, plan: PlanRow): Promise<PlanExportResult> {
  const stem = plan.source_file ?? `${formatPlanNo(plan.number)}.${fileSafeName(plan.name)}`;
  const dir = join(projectRoot, '.o4c', 'plans');
  await mkdir(dir, { recursive: true });
  const planFile = join(dir, `${stem}.plan.md`);
  const checklistFile = join(dir, `${stem}.checklist.md`);
  await writeFile(planFile, planMarkdown(plan), 'utf-8');
  await writeFile(checklistFile, checklistMarkdown(plans, plan), 'utf-8');
  if (plan.source_file !== stem) plans.setSourceFile(plan.id, stem);
  return { planFile, checklistFile };
}

/** `Export Plans: v2!` -> `ExportPlansV2`: the convention's `Name` part is one word. */
export function fileSafeName(name: string): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return joined || 'Plan';
}

const SNAPSHOT_NOTE = (when: string) =>
  `_Exported from o4c ${when}. A snapshot: the plan lives in o4c (/view-plan), and editing this file changes nothing there._`;

export function planMarkdown(plan: PlanRow, now = new Date()): string {
  const lines = [`# ${formatPlanNo(plan.number)}. ${plan.name}`, '', SNAPSHOT_NOTE(now.toISOString().slice(0, 10)), ''];
  if (plan.goal) lines.push(`**Goal:** ${plan.goal}`, '');
  if (plan.summary) lines.push(`**Summary:** ${plan.summary}`, '');
  if (plan.body) lines.push(plan.body.trimEnd(), '');
  return lines.join('\n');
}

export function checklistMarkdown(plans: PlanStore, plan: PlanRow, now = new Date()): string {
  const lines = [`# ${formatPlanNo(plan.number)}. ${plan.name} - checklist`, '', SNAPSHOT_NOTE(now.toISOString().slice(0, 10)), ''];
  for (const item of plans.items(plan.id)) {
    const [first, ...rest] = item.text.split('\n');
    lines.push(STATUS_LINE[item.status](`${item.position}. ${first}`));
    for (const line of rest) lines.push(`      ${line}`);
    for (const check of item.checks.split('\n').filter(Boolean)) lines.push(`  - ${check}`);
    if (item.verification && item.status === 'done') lines.push(`      Verified: ${item.verification.replace(/\s+/g, ' ')}`);
    for (const note of item.notes.split('\n').filter(Boolean)) lines.push(`      Note: ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}
