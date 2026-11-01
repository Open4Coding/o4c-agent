import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listPlans, type PlanEntry } from './plansStore.js';
import { formatPlanNo, type NewPlanItem, type PlanStore } from './planStore.js';

/**
 * The one-time import of `.o4c/plans/*.md` into SQLite - brief 0005, Q2 / checklist P2.
 *
 * Plans written as files before plans moved into `history.db` (Plan-Write mode could always write
 * them) are copied in, and the files stay where they are, treated as exports from then on.
 * "One-time" is per plan, not per project: each imported plan remembers its file stem in
 * `source_file`, so running this again - on every start, which is what makes it cheap to call -
 * imports only plans that are new on disk and never duplicates one. A file whose plan is already
 * in the store is not read again, so editing an exported file does not flow back (Q1: the files
 * are snapshots).
 *
 * Parsing is deliberately plain - these files are free-form markdown, often written by a model:
 * - `.plan.md` becomes the body; its first paragraph that is not a heading becomes the summary.
 * - `.checklist.md`: each top-level `- [ ]` / `- [x]` line is an item; an indented checkbox line
 *   under it is one of its checks; other indented lines continue the item's text. A `[x]` item is
 *   imported as done, with a verification note saying so - the store's done rule holds for
 *   imports too, and the note is honest about where the "done" came from.
 * Files that do not fit the naming convention are reported, never guessed at (same as `/plans`).
 */

export interface PlanImportResult {
  /** `0001.Name` for each plan imported this time. */
  readonly imported: readonly string[];
  /** Plans imported under a different number because the file's number was already taken. */
  readonly renumbered: readonly string[];
  /** File names that are not `NNNN.Name.<kind>.md`. */
  readonly unrecognised: readonly string[];
}

const SUMMARY_CHARS = 600;

export async function importPlanFiles(projectRoot: string | undefined, plans: PlanStore): Promise<PlanImportResult> {
  const listing = await listPlans(projectRoot);
  const imported: string[] = [];
  const renumbered: string[] = [];
  if (!projectRoot) return { imported, renumbered, unrecognised: listing.unrecognised };
  const dir = join(projectRoot, '.o4c', 'plans');

  for (const entry of listing.plans) {
    const stem = `${entry.prefix}.${entry.name}`;
    if (plans.getPlanBySourceFile(stem)) continue;
    const body = await readKind(dir, entry, 'plan');
    const checklist = await readKind(dir, entry, 'checklist');
    const items = parseChecklist(checklist);
    const taken = plans.getPlanByNumber(entry.number) !== undefined;
    const plan = plans.createPlan({
      name: entry.name,
      body,
      summary: summaryOf(body),
      items: items.map(({ text, checks }) => ({ text, checks })),
      source_file: stem,
      number: taken ? undefined : entry.number,
    });
    items.forEach((item, i) => {
      if (item.done) {
        plans.setItemStatus(plan.id, i + 1, 'done', { verification: `Imported as done from ${stem}.checklist.md` });
      }
    });
    imported.push(stem);
    if (taken) renumbered.push(`${stem} -> ${formatPlanNo(plan.number)}`);
  }
  return { imported, renumbered, unrecognised: listing.unrecognised };
}

async function readKind(dir: string, entry: PlanEntry, kind: 'plan' | 'checklist'): Promise<string> {
  const file = entry.files.find((f) => f.kind === kind);
  if (!file) return '';
  return readFile(join(dir, file.fileName), 'utf-8').catch(() => '');
}

export interface ParsedItem extends NewPlanItem {
  readonly done: boolean;
}

const CHECKBOX = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;

/** Checklist markdown -> items. Exported for tests. */
export function parseChecklist(markdown: string): ParsedItem[] {
  const items: { text: string[]; checks: string[]; done: boolean }[] = [];
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const box = CHECKBOX.exec(raw);
    const indented = /^\s+\S/.test(raw);
    if (box && box[1].length === 0) {
      items.push({ text: [box[3].trim()], checks: [], done: box[2] !== ' ' });
    } else if (items.length > 0 && box) {
      items[items.length - 1].checks.push(box[3].trim());
    } else if (items.length > 0 && indented) {
      items[items.length - 1].text.push(raw.trim());
    }
    // Anything else - headings, prose between items, blank lines - is not part of an item.
  }
  return items.map((i) => ({ text: i.text.join('\n'), checks: i.checks.join('\n'), done: i.done }));
}

/** The first paragraph that is not a heading, flattened and capped. Exported for tests. */
export function summaryOf(markdown: string): string {
  const paragraphs = markdown.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  // A heading line glued to its first paragraph (no blank line between) is dropped, not the paragraph.
  const first = paragraphs
    .map((p) => p.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n').trim())
    .find((p) => p !== '');
  if (!first) return '';
  const flat = first.replace(/\s+/g, ' ');
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS - 3)}...`;
}
