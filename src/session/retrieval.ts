import { basename } from 'node:path';
import { taskNumber, type InfiniteContextStore, type TaskRow, type TaskSearchRow } from './infiniteContextStore.js';

/**
 * Finding past tasks - NextUp item 23, checklist B4/B5. One module behind every surface that
 * searches (the `search_history` tool, the `pointer` hint, `curated` context), so they rank the
 * same way and every search lands in `search_log` the same way.
 *
 * Reads only a task's key parts, never the bulky entries (brief, Q10): whatever is archived later,
 * this keeps working.
 */

/** Words that say nothing about *which* task this is - stopwords plus the verbs every request
 * uses. Without them "fix the bug in the file" would match half the history. */
const STOPWORDS = new Set(
  (
    'the and for with that this from into onto have has had was were are is be been being you your ' +
    'yours our ours their them they what when where which while who whom why how can could should ' +
    'would will shall may might must not but all any each every some such than then there these those ' +
    'too very just also only now here out off over under again more most other same own its it\'s ' +
    'please make makes made fix fixes fixed add adds added use uses used get gets got set sets create ' +
    'creates created write writes wrote written update updates updated change changes changed new ' +
    'try again want need like let lets look see show tell give find run runs ran one two file files ' +
    'code thing things way work works working done does did doing do yes no ok okay thanks thank'
  ).split(/\s+/),
);

/** Lowercased words of three letters or more that are not stopwords, each once. */
export function meaningfulTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))];
}

/**
 * Exact names in a message: file names (`tetris.html`, `src/ui/App.tsx`) and code identifiers
 * (`formatEvent`, `tool_call_id`, `HTTPServer2`) - one of these alone qualifies a task (brief, Q8),
 * because nobody types `formatEvent` by accident.
 */
export function exactNames(text: string): string[] {
  const names = new Set<string>();
  for (const token of text.match(/[A-Za-z0-9_./\\-]+/g) ?? []) {
    const clean = token.replace(/^[./\\-]+|[./\\-]+$/g, '');
    if (/^[\w./\\-]+\.[A-Za-z0-9]{1,6}$/.test(clean) && /[A-Za-z]/.test(clean)) {
      names.add(clean.replace(/\\/g, '/'));
    } else if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(clean) || /^[A-Za-z]+_[A-Za-z0-9_]+$/.test(clean) || /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(clean)) {
      names.add(clean);
    }
  }
  return [...names];
}

/** An FTS5 MATCH expression for a message, or `undefined` when there is nothing to search on.
 * Every term is quoted, so nothing the user typed is read as FTS5 syntax. */
export function ftsQuery(text: string): string | undefined {
  const parts = new Set(meaningfulTerms(text));
  for (const name of exactNames(text)) parts.add(name.toLowerCase());
  if (parts.size === 0) return undefined;
  return [...parts].map((p) => `"${p.replace(/"/g, '""')}"`).join(' OR ');
}

/** Whether a task clears the `pointer` bar (brief, Q8): at least two meaningful words in common
 * with the message, or one exact file name or identifier. */
export function qualifies(task: Pick<TaskRow, 'title' | 'request' | 'files'>, message: string): boolean {
  const taskText = `${task.title}\n${task.request}\n${task.files}`;
  const taskTerms = new Set(meaningfulTerms(taskText));
  const shared = meaningfulTerms(message).filter((t) => taskTerms.has(t));
  if (shared.length >= 2) return true;
  const files = task.files.split('\n').filter(Boolean);
  return exactNames(message).some(
    (name) => taskText.includes(name) || files.some((f) => f === name || basename(f) === basename(name)),
  );
}

/** A thread as shown: its top-level task, how it ranked, and what to say about it. */
export interface RankedThread {
  readonly root: TaskRow;
  readonly number: string;
  readonly followUps: number;
  readonly score: number;
  /** True when code the thread changed has since disappeared; undefined when that cannot be said. */
  readonly stale: boolean | undefined;
}

export interface HistoryRetrievalOptions {
  readonly store: InfiniteContextStore;
  readonly sessionId: string;
  /** The task the current exchange is filed under - left out of its own searches. */
  readonly currentTask: () => number | undefined;
  /** The Code Graph's identity lookup, `undefined` while it cannot say (see `entityExists`). */
  readonly entityExists?: (entityUid: string) => boolean | undefined;
  readonly now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many recent searches a pick can be credited to. */
const PICK_MEMORY = 8;

export class HistoryRetrieval {
  private readonly recent: Array<{ id: number; shown: Set<number> }> = [];

  constructor(private readonly options: HistoryRetrievalOptions) {}

  /**
   * Ranked threads for a message. Relevance is BM25 over the key parts; a task marked "worked" is
   * boosted (and one marked as not working pushed down), then the "used" count, then recency as a
   * small tiebreaker (brief, Q8). The weights are a starting point to tune on real data.
   */
  rank(message: string, options: { qualify?: boolean; limit?: number } = {}): RankedThread[] {
    const match = ftsQuery(message);
    if (!match) return [];
    const { store } = this.options;
    let hits: TaskSearchRow[];
    try {
      hits = store.searchTasks(match, 50, this.options.currentTask());
    } catch {
      return [];
    }
    if (options.qualify) hits = hits.filter((h) => qualifies(h, message));

    const now = (this.options.now ?? Date.now)();
    const best = new Map<number, number>();
    for (const hit of hits) {
      const worked = hit.worked === 1 ? 1.5 : hit.worked === 0 ? 0.5 : 1;
      const used = 1 + 0.1 * Math.log1p(hit.used_count);
      const recency = 1 + 0.1 * Math.exp(-(now - hit.started_at) / (30 * DAY_MS));
      const score = -hit.bm25 * worked * used * recency;
      const root = hit.parent_task_id ?? hit.id;
      if (score > (best.get(root) ?? -Infinity)) best.set(root, score);
    }

    return [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.limit ?? 8)
      .flatMap(([rootId, score]) => {
        const root = store.getTask(rootId);
        if (!root) return [];
        return [{ root, number: taskNumber(root), followUps: store.followUps(rootId).length, score, stale: this.staleness(rootId) }];
      });
  }

  /** Logs a search and remembers what it showed, so a later `open` can be credited to it. */
  record(source: 'tool' | 'pointer' | 'curated' | 'ultraplan', query: string, shown: readonly RankedThread[]): number | undefined {
    try {
      const ids = shown.map((t) => t.root.id);
      const id = this.options.store.recordSearch({ session_id: this.options.sessionId, task_id: this.options.currentTask() ?? null, source, query, shown: ids });
      this.recent.unshift({ id, shown: new Set(ids) });
      this.recent.length = Math.min(this.recent.length, PICK_MEMORY);
      return id;
    } catch {
      return undefined;
    }
  }

  /** Credits opening a task to the most recent search that showed it - the automatic "used" count. */
  creditPick(rootId: number): void {
    const search = this.recent.find((s) => s.shown.has(rootId));
    if (!search) return;
    try {
      this.options.store.recordPicks(search.id, [rootId]);
    } catch {
      // A missed count costs ranking a little, never the answer.
    }
  }

  /** `pointer`'s one-line hint, or `undefined` when nothing qualifies - then nothing is sent and
   * nothing is spent (brief, Q8). */
  pointerHint(request: string): string | undefined {
    const threads = this.rank(request, { qualify: true, limit: 3 });
    if (threads.length === 0) return undefined;
    this.record('pointer', request, threads);
    const named = threads.map((t) => `${t.number} "${t.root.title}"${describeThread(t)}`).join(', ');
    return `[o4c history] Past tasks that may help: ${named}. Read one with search_history {"open": "${threads[0].number}"} - or ignore this if it is not relevant.`;
  }

  /** True when a thread changed code that no longer exists; undefined when that cannot be said. */
  private staleness(rootId: number): boolean | undefined {
    const check = this.options.entityExists;
    if (!check) return undefined;
    const { store } = this.options;
    const ids = [rootId, ...store.followUps(rootId).map((t) => t.id)];
    let unknown = false;
    for (const id of ids) {
      for (const row of store.taskEntities(id)) {
        if (!row.entity_uid || row.hash_after === null) continue;
        const exists = check(row.entity_uid);
        if (exists === false) return true;
        if (exists === undefined) unknown = true;
      }
    }
    return unknown ? undefined : false;
  }
}

/** The bracketed notes after a thread's title: follow-ups, the "worked" mark, staleness. */
export function describeThread(thread: RankedThread): string {
  const notes: string[] = [];
  if (thread.followUps > 0) notes.push(`+${thread.followUps} follow-up${thread.followUps === 1 ? '' : 's'}`);
  if (thread.root.worked === 1) notes.push('marked worked');
  if (thread.root.worked === 0) notes.push('marked did not work');
  if (thread.stale) notes.push('stale: code it changed is gone');
  return notes.length > 0 ? ` (${notes.join('; ')})` : '';
}
