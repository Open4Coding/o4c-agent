import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The `.o4c/plans/` directory: front-end checklist item 10, the browsing half.
 *
 * A plan is a *set* of files sharing one number and name, not a single file - the convention this
 * project already dogfoods in `D:\AngelCode\docs\plans\`:
 *
 *   0001.FrontEndIDEChanges.plan.md            the plan itself
 *   0001.FrontEndIDEChanges.checklist.md       the flat, checkable execution list derived from it
 *   0001.FrontEndIDEChanges.planningsession.md the raw planning conversation it was distilled from
 *
 * **Reading only.** Writing already works and did before this file existed: Plan-Write mode
 * (design doc §9.3) permits `write_file` scoped to exactly this directory, and `plansDirFor`
 * (`projectContext.ts`) is what scopes it. So the gap item 10 names is the *index* - knowing what
 * plans exist without shelling out to `ls` - and that is what this provides. No numbering helper
 * is offered for writing yet; see `nextPlanNumber`'s own note.
 *
 * **Project-scoped, with no global fallback**, the same rule `plansDirFor` already follows: a plan
 * document is inherently tied to the project it plans.
 */

/** The three roles a plan file can have. Anything else in the directory is reported, not hidden. */
export type PlanFileKind = 'plan' | 'checklist' | 'planningsession';

const KINDS: readonly PlanFileKind[] = ['plan', 'checklist', 'planningsession'];

export interface PlanFile {
  readonly kind: PlanFileKind;
  readonly fileName: string;
  /** Last-modified time, for showing which plan was touched most recently. */
  readonly modified: Date;
}

export interface PlanEntry {
  /** The `NNNN` prefix as a number, so ordering is numeric rather than lexicographic. */
  readonly number: number;
  /** The `NNNN` prefix exactly as written, so a listing can echo the real file name. */
  readonly prefix: string;
  readonly name: string;
  /** The files found for this plan, in `plan`/`checklist`/`planningsession` order. */
  readonly files: readonly PlanFile[];
  /** The newest `modified` across its files. */
  readonly modified: Date;
}

export interface PlansListing {
  readonly plans: readonly PlanEntry[];
  /**
   * File names in the directory that do not fit `NNNN.Name.<kind>.md`.
   *
   * Reported rather than silently skipped, because the likeliest cause is a typo in a name the
   * user or the model just wrote - and a plan that exists but does not appear in `/plans` is worse
   * than one that appears with a complaint attached.
   */
  readonly unrecognised: readonly string[];
}

/** `0001.FrontEndIDEChanges.plan.md` -> prefix/name/kind. Case-insensitive on the kind only. */
const FILE_PATTERN = /^(\d{1,8})\.(.+)\.(plan|checklist|planningsession)\.md$/i;

/**
 * Lists the plans in a project's `.o4c/plans/`.
 *
 * Returns an empty listing rather than throwing for a missing directory, an untrusted project
 * (`projectRoot` undefined) or an unreadable one. `/plans` is an informational command: it must
 * degrade to "there are none" instead of becoming the one command that can error out, which is the
 * same treatment `loadMcpServers` gives unreadable MCP config.
 */
export async function listPlans(projectRoot: string | undefined): Promise<PlansListing> {
  const dir = projectRoot ? join(projectRoot, '.o4c', 'plans') : undefined;
  if (!dir) return { plans: [], unrecognised: [] };

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { plans: [], unrecognised: [] };
  }

  const byKey = new Map<string, { prefix: string; number: number; name: string; files: PlanFile[] }>();
  const unrecognised: string[] = [];

  for (const fileName of names) {
    const match = FILE_PATTERN.exec(fileName);
    if (!match) {
      unrecognised.push(fileName);
      continue;
    }
    const [, prefix, name, kindRaw] = match;
    const kind = kindRaw.toLowerCase() as PlanFileKind;
    let modified: Date;
    try {
      modified = (await stat(join(dir, fileName))).mtime;
    } catch {
      // Deleted between readdir and stat, or unreadable. It is still a plan file that exists as
      // far as the name goes; epoch sorts it last rather than dropping it from the listing.
      modified = new Date(0);
    }
    // Keyed on the number AND the name: two different plans cannot share a number under the
    // convention, but a directory can still end up that way, and merging them would misreport
    // both.
    const key = `${Number(prefix)}\u0000${name}`;
    const existing = byKey.get(key);
    if (existing) existing.files.push({ kind, fileName, modified });
    else byKey.set(key, { prefix, number: Number(prefix), name, files: [{ kind, fileName, modified }] });
  }

  const plans: PlanEntry[] = [...byKey.values()]
    .map((p) => ({
      number: p.number,
      prefix: p.prefix,
      name: p.name,
      files: [...p.files].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)),
      modified: p.files.reduce((latest, f) => (f.modified > latest ? f.modified : latest), new Date(0)),
    }))
    .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  return { plans, unrecognised: unrecognised.sort() };
}

/**
 * The number a new plan should use: one past the highest present.
 *
 * Exported for the authoring half of item 10 (a `write_plan`-style capability), which is not built
 * - **and this is why it is only a number and not a "create the plan" helper.** Choosing the
 * number is the part with a real rule; creating the files is a `write_file` call that Plan-Write
 * mode already permits, and wrapping that would add a second way to do the same thing.
 *
 * Note it is derived from what is on disk each time rather than from a stored counter: a counter
 * would be a third thing to keep in step with the directory, and the directory is the truth.
 */
export function nextPlanNumber(listing: PlansListing): number {
  return listing.plans.reduce((highest, p) => Math.max(highest, p.number), 0) + 1;
}

/** Zero-pads to the 4-digit convention. `10001` stays 5 digits rather than being truncated. */
export function formatPlanNumber(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * The lines `/plans` prints.
 *
 * Pure, so the wording is assertable without a filesystem - the same reason `statusReport` lives
 * beside the MCP startup code rather than in the UI.
 */
export function plansReport(listing: PlansListing, hasProject: boolean): readonly string[] {
  if (!hasProject) {
    return [
      'No project is open, so there are no plans.',
      'Plans live in .o4c/plans/ inside a trusted project.',
    ];
  }
  if (listing.plans.length === 0 && listing.unrecognised.length === 0) {
    // Named path plus the naming rule: "no plans" is indistinguishable from "o4c cannot do plans"
    // unless the user can see where they would go.
    return [
      'No plans yet.',
      'They live in .o4c/plans/, named NNNN.Name.plan.md (plus .checklist.md and .planningsession.md).',
      'Switch to Plan-Write mode to let o4c write one.',
    ];
  }

  const lines: string[] = [];
  if (listing.plans.length > 0) {
    lines.push('Plans:');
    for (const plan of listing.plans) {
      // The kinds present, so a plan with no checklist is visibly different from one with all
      // three - that difference is the main thing a glance at this list is for.
      const kinds = plan.files.map((f) => f.kind).join(', ');
      lines.push(`  ${plan.prefix}.${plan.name} - ${kinds}`);
    }
  }
  if (listing.unrecognised.length > 0) {
    lines.push(
      '',
      'Not recognised as plan files (expected NNNN.Name.plan|checklist|planningsession.md):',
    );
    for (const name of listing.unrecognised) lines.push(`  ${name}`);
  }
  return lines;
}
