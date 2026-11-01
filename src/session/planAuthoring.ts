import { parseChecklist, summaryOf } from './planImport.js';
import { PlanRuleError, formatPlanNo, type PlanKind, type PlanRow, type PlanStore } from './planStore.js';

/**
 * `/plan` and `/ultraplan` - brief 0005, decisions 2-3 / checklist P5-P6.
 *
 * A planning command is an ordinary model turn with three differences, all decided here so
 * `App.tsx` only has to route: the prompt sent is a planning instruction around the user's goal;
 * the turn runs read-only (Plan mode, whatever mode the user is in); and the answer, which the
 * instruction asks for in a fixed markdown shape, is parsed and saved as a new plan that becomes
 * the session's active one.
 *
 * The shape is plain markdown rather than JSON on purpose: every model writes it reliably, it is
 * what the user reads on screen anyway, and the checklist half is the same format the importer
 * already parses - one parser for both ways a plan can arrive.
 */

/** What `App.tsx` needs to save and announce plans. Absent without a trusted project. */
export interface PlanHooks {
  readonly store: PlanStore;
  readonly sessionId: string;
  /** Re-offers `update_plan` once a first plan exists (`syncPlanTool` in cli.ts). */
  readonly changed: () => void;
  readonly currentTask: () => number | undefined;
  /** `/ultraplan`'s fixed research steps for a goal (`ultraplanResearch.ts`). Absent: none run. */
  readonly research?: (goal: string) => string;
}

export interface PlanCommand {
  readonly kind: PlanKind;
  readonly goal: string;
}

/** `/plan <goal>` or `/ultraplan <goal>`; `undefined` for anything else. An empty goal is a
 * command with nothing to plan - returned with `goal: ''` so the caller can say so. */
export function parsePlanCommand(input: string): PlanCommand | undefined {
  const match = /^\/(plan|ultraplan)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return undefined;
  return { kind: match[1] as PlanKind, goal: (match[2] ?? '').trim() };
}

const ANSWER_SHAPE = [
  'When you are done investigating, answer with the plan in exactly this shape (markdown):',
  '',
  '# <a short name for the plan, 2-5 words>',
  '',
  'Summary: <two or three sentences: what will be built and how>',
  '',
  '## Plan',
  '<the plan itself: approach, the files and functions involved, risks, decisions to make>',
  '',
  '## Checklist',
  '- [ ] <one concrete step, small enough to finish and verify on its own>',
  '  - [ ] <how to check that step is really done: a test to run, a result to see>',
  '- [ ] <the next step>',
  '',
  'Order the checklist in the order the work should be done. Every step gets at least one check.',
  'Write each step so someone new to this project could follow it - name the file, the function,',
  'the command; no "as discussed" and no unexplained shorthand.',
].join('\n');

/**
 * The text sent to the model. Its first line is the user's own command, so the history task this
 * turn becomes is titled `/plan <goal>` like any other request (brief 0004, Q7: titles are what
 * was asked). `research` is `/ultraplan`'s pre-gathered material (checklist P6).
 */
export function planPrompt(command: PlanCommand, research?: string): string {
  const lead = command.kind === 'ultraplan'
    ? [
        'Make a thorough plan for the goal above. Material o4c already gathered for it is below -',
        'read it first. Then investigate further only where it leaves a real question open, and',
        'stop as soon as the plan is clear. Do not change anything: this is planning, not doing.',
      ]
    : [
        'Make a plan for the goal above. Look at what you need to - the relevant files, past tasks',
        '(search_history), the code graph - but keep it short, and do not change anything: this is',
        'planning, not doing.',
      ];
  return [
    `/${command.kind} ${command.goal}`,
    '',
    ...lead,
    ...(research ? ['', '--- gathered by o4c ---', research.trim(), '--- end ---'] : []),
    '',
    ANSWER_SHAPE,
  ].join('\n');
}

export interface ParsedPlan {
  readonly name: string;
  readonly summary: string;
  readonly body: string;
  readonly items: { text: string; checks: string }[];
}

/** The answer back into a plan, or why it could not be. Lenient where models drift (heading
 * levels, a missing "Summary:" label), strict on the one thing a plan needs: checklist items. */
export function parsePlanAnswer(answer: string): ParsedPlan | { error: string } {
  const text = answer.replace(/\r\n/g, '\n');
  const sections = splitSections(text);
  const checklistText = sections.get('checklist') ?? '';
  const items = parseChecklist(checklistText).map(({ text: t, checks }) => ({ text: t, checks: checks ?? '' }));
  if (items.length === 0) {
    return { error: 'The answer has no "## Checklist" with "- [ ]" items, so there is nothing to save as a plan.' };
  }
  const name = (/^#\s+(.+)$/m.exec(text)?.[1] ?? '').trim().replace(/^plan:\s*/i, '');
  const summaryLine = /^\s*\**summary:?\**:?\s*(.+)$/im.exec(text)?.[1]?.trim();
  const body = (sections.get('plan') ?? '').trim();
  return {
    name: name || 'Untitled plan',
    summary: summaryLine ?? summaryOf(body),
    body: body || text.trim(),
    items,
  };
}

/** `## Heading` -> its text, keyed by the heading lowercased (any level from 2 down). */
function splitSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (current !== undefined && !sections.has(current)) sections.set(current, lines.join('\n'));
  };
  for (const line of text.split('\n')) {
    const heading = /^#{2,6}\s+(.+?)\s*:?\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].toLowerCase();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Saves a planning turn's answer as a new plan, made the session's active one. Returns the line
 * to show either way - the plan's number and how to see it, or why nothing was saved.
 */
export function savePlanFromAnswer(hooks: PlanHooks, command: PlanCommand, answer: string): { plan?: PlanRow; message: string } {
  const parsed = parsePlanAnswer(answer);
  if ('error' in parsed) return { message: `${parsed.error} Ask again, or run /${command.kind} with a clearer goal.` };
  try {
    const plan = hooks.store.createPlan({
      name: parsed.name,
      kind: command.kind,
      goal: command.goal,
      summary: parsed.summary,
      body: parsed.body,
      items: parsed.items,
      session_id: hooks.sessionId,
      task_id: hooks.currentTask(),
    });
    hooks.store.activate(plan.id, hooks.sessionId);
    hooks.changed();
    const count = parsed.items.length;
    return {
      plan,
      message:
        `Saved as plan ${formatPlanNo(plan.number)} "${plan.name}" (${count} item${count === 1 ? '' : 's'}), now the active plan. ` +
        'See it with /view-plan; ask o4c to start on it when you are ready.',
    };
  } catch (err) {
    if (err instanceof PlanRuleError) return { message: err.message };
    throw err;
  }
}
