import type { InfiniteContextStore } from './infiniteContextStore.js';
import { formatTaskForContext } from './historyTool.js';
import type { HistoryRetrieval } from './retrieval.js';

/**
 * `/ultraplan`'s fixed research steps - brief 0005, Q6 / checklist P6.
 *
 * Done by o4c before the model starts, not asked of it: the tmp4 run showed Qwen over-researching
 * when left to choose, and the fixed steps are what guarantee the obvious places get looked at
 * whatever the model's habits. The model then gets a small, bounded follow-up (`ULTRAPLAN_MAX_ITERATIONS`)
 * to chase what this turned up.
 *
 *   1. Past tasks that match the goal - the top few opened, as `search_history` would show them.
 *   2. The Code Graph's ranked map, personalised by the names in the goal and the files those
 *      tasks touched - which files and definitions matter for this goal.
 *
 * Each source is optional and capped; a missing one is said, not silently skipped, so the model
 * does not plan as if a source had been checked when it was not there.
 */

/** Tool rounds the model gets after the gathered material - the "bounded follow-up". */
export const ULTRAPLAN_MAX_ITERATIONS = 15;

const PAST_TASKS_OPENED = 3;
const PAST_TASK_CHARS = 2500;
const GRAPH_MAP_TOKENS = 1500;

export interface UltraplanSources {
  readonly store?: InfiniteContextStore;
  readonly retrieval?: HistoryRetrieval;
  /** The Code Graph's ranked map for a goal, or undefined when the graph is off or not ready. */
  readonly graphMap?: (focus: { idents: string[]; files: string[] }, maxTokens: number) => string | undefined;
}

export function gatherUltraplanResearch(goal: string, sources: UltraplanSources): string {
  const parts: string[] = [];
  const files = new Set<string>();

  if (sources.store && sources.retrieval) {
    const threads = sources.retrieval.rank(goal, { limit: PAST_TASKS_OPENED });
    sources.retrieval.record('ultraplan', goal, threads);
    if (threads.length === 0) {
      parts.push('Past tasks: none match this goal.');
    } else {
      parts.push(`Past tasks (${threads.length} best matches, opened):`);
      for (const thread of threads) {
        const text = formatTaskForContext(sources.store, thread.root);
        parts.push(text.length <= PAST_TASK_CHARS ? text : `${text.slice(0, PAST_TASK_CHARS)}... (cut)`, '');
        for (const f of thread.root.files.split('\n').filter(Boolean)) files.add(f);
      }
    }
  } else {
    parts.push('Past tasks: no history store in this project.');
  }

  const map = sources.graphMap?.({ idents: identifiersIn(goal), files: [...files] }, GRAPH_MAP_TOKENS);
  parts.push(map ? `Code Graph - the files and definitions that rank highest for this goal:\n${map}` : 'Code Graph: not available (off, or still indexing).');
  return parts.join('\n').trim();
}

/** Words in the goal that look like code names: camelCase, snake_case, dotted, or a file name. */
export function identifiersIn(goal: string): string[] {
  const words = goal.match(/[A-Za-z_][\w.]*/g) ?? [];
  return [...new Set(words.filter((w) => /[a-z][A-Z]|_|\.\w/.test(w)))];
}
