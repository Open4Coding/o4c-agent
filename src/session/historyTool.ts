import type { Tool } from '../tools/types.js';
import { taskNumber, type InfiniteContextStore, type TaskRow } from './infiniteContextStore.js';
import { describeThread, type HistoryRetrieval } from './retrieval.js';

/**
 * `search_history` - the model's own way into the history store (NextUp item 23, checklist B4).
 *
 * Two verbs on one tool, because a model that has to pick between two tools for one job picks
 * badly: `query` lists matching past tasks by number and title, `open` reads one task's key parts.
 * Listing first and opening second is the same two-step shape `curated` uses (brief, Q4) - choosing
 * from titles is the easy part even for a weak model.
 *
 * Read-only, so no mode ever asks before running it.
 */

/** Caps per key part when a task is opened - enough to act on, never a wall. */
const OPEN_CAPS = { request: 2000, answer: 4000, errors: 1200 } as const;

export function createHistoryTool(store: InfiniteContextStore, retrieval: HistoryRetrieval): Tool {
  return {
    name: 'search_history',
    description:
      "Search this project's past tasks (earlier requests, what was done, what failed, which files and functions changed). " +
      'Pass {"query": "words or names"} to list matching tasks by number, then {"open": "#412"} to read one. ' +
      'Use it when the request looks like something done before, or to check how an earlier problem was solved.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words, file names or function names to search past tasks for.' },
        open: { type: 'string', description: 'A task number from a search result, e.g. "#412" or "#412.1".' },
      },
    },
    async execute(input) {
      if (typeof input.open === 'string' && input.open.trim()) return openTask(store, retrieval, input.open);
      if (typeof input.query === 'string' && input.query.trim()) return searchTasks(retrieval, input.query);
      return 'Pass {"query": "..."} to search past tasks, or {"open": "#N"} to read one.';
    },
  };
}

function searchTasks(retrieval: HistoryRetrieval, query: string): string {
  const threads = retrieval.rank(query, { limit: 8 });
  retrieval.record('tool', query, threads);
  if (threads.length === 0) return `No past tasks match "${query}".`;
  const lines = threads.map((t) => {
    const answer = oneLine(t.root.answer, 100);
    const files = t.root.files ? `; files: ${t.root.files.split('\n').slice(0, 4).join(', ')}` : '';
    return `${t.number} ${t.root.title}${describeThread(t)}${files}\n    ${answer ? `answer: ${answer}` : `(${t.root.outcome})`}`;
  });
  return [
    `${threads.length} past task${threads.length === 1 ? '' : 's'} match "${query}":`,
    ...lines,
    'Read one with {"open": "<number>"}.',
  ].join('\n');
}

function openTask(store: InfiniteContextStore, retrieval: HistoryRetrieval, number: string): string {
  const task = store.getTaskByNumber(number);
  if (!task) return `No past task ${number}. Search first with {"query": "..."} to get numbers.`;
  retrieval.creditPick(task.parent_task_id ?? task.id);
  return formatTaskForContext(store, task);
}

/**
 * One task's key parts as the model reads them - shared by `open` and `curated`, so a task looks
 * the same whichever way it arrived. `stale` is the thread's staleness when the caller knows it.
 */
export function formatTaskForContext(store: InfiniteContextStore, task: TaskRow, stale?: boolean): string {
  const lines = [`${taskNumber(task)} ${task.title}`, `Outcome: ${describeOutcome(task)}`];
  if (stale) lines.push('Note: code this task changed has since been removed or renamed - check before relying on it.');
  lines.push(`Request: ${cap(task.request, OPEN_CAPS.request)}`);
  // An empty answer on a finished task is what an archived one looks like too (brief, Q10, rule 2):
  // normal, not an error.
  lines.push(`Answer: ${task.answer ? cap(task.answer, OPEN_CAPS.answer) : task.outcome === 'open' ? '(still running)' : '[none recorded, or archived]'}`);
  if (task.errors) lines.push(`Errors: ${cap(task.errors, OPEN_CAPS.errors)}`);
  if (task.files) lines.push(`Files written: ${task.files.split('\n').join(', ')}`);
  const changed = store
    .taskEntities(task.id)
    .filter((e) => e.name)
    .map((e) => `${e.name} (${e.change})`);
  if (changed.length > 0) lines.push(`Definitions changed: ${changed.join(', ')}`);

  const rootId = task.parent_task_id ?? task.id;
  const thread = [store.getTask(rootId), ...store.followUps(rootId)].filter((t): t is TaskRow => !!t && t.id !== task.id);
  if (thread.length > 0) {
    lines.push('Same thread:');
    for (const t of thread) lines.push(`  ${taskNumber(t)} ${t.title}${t.answer ? ` - ${oneLine(t.answer, 80)}` : ''}`);
  }
  return lines.join('\n');
}

function describeOutcome(task: TaskRow): string {
  const mark = task.worked === 1 ? ', marked worked' : task.worked === 0 ? ', marked did not work' : '';
  return `${task.outcome}${mark}, ${new Date(task.started_at).toISOString().slice(0, 10)}`;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (+${text.length - max} characters)`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}
