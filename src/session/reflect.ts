import type { TaskRow } from './infiniteContextStore.js';

/**
 * `/reflect` (plan 0006 D4): ask the model, once and only when the user asks, what is worth
 * remembering from the project's recent finished tasks - at most three one-sentence lessons, which
 * the user then picks from to save as memories. Nothing is saved without that choice, and nothing
 * runs on its own (it costs a model call).
 */

export const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 240 },
    },
  },
  required: ['lessons'],
} as const;

let source: (() => TaskRow[]) | undefined;

/** Set by cli.ts from history.db; undefined when there is no history (untrusted directory). */
export function setRecentTasksSource(next: (() => TaskRow[]) | undefined): void {
  source = next;
}

export function recentTasks(): TaskRow[] {
  return source?.() ?? [];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

/** The request text: each task's request, what it worked out, what went wrong, and its answer. */
export function reflectPrompt(tasks: readonly TaskRow[]): string {
  const blocks = tasks.map(
    (t, i) =>
      `Task ${i + 1}${t.worked === 1 ? ' (marked as worked)' : ''}: ${clip(t.request, 300)}\n` +
      (t.notes ? `Worked out: ${clip(t.notes, 500)}\n` : '') +
      (t.errors ? `Errors met: ${clip(t.errors, 300)}\n` : '') +
      `Answer: ${clip(t.answer, 300)}`,
  );
  return [
    "These are recent finished tasks in this project. What, if anything, should be remembered for future sessions here?",
    'Give at most three lessons, one sentence each, that would save time or avoid a mistake next time:',
    'project conventions, commands that work, traps that cost a retry. Nothing generic, nothing about one task only.',
    'If nothing is worth keeping, return an empty list.',
    '',
    ...blocks,
  ].join('\n');
}

/** The lessons from the model's JSON reply; [] when it is not the expected shape. */
export function parseLessons(text: string): string[] {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { lessons?: unknown };
    return Array.isArray(parsed.lessons) ? parsed.lessons.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()).slice(0, 3) : [];
  } catch {
    return [];
  }
}
