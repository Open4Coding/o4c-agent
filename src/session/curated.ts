import type { CompletionRequest, CompletionResponse } from '../providers/types.js';
import { estimateTextTokens } from '../agent/contextEntry.js';
import type { InfiniteContextStore } from './infiniteContextStore.js';
import { formatTaskForContext } from './historyTool.js';
import { describeThread, type HistoryRetrieval, type RankedThread } from './retrieval.js';

/**
 * `curated` - the model builds its own context from past tasks (NextUp item 23, checklist B6;
 * brief Q3-Q5). Two short calls before the turn:
 *
 * 1. The model reads the request and writes 1-3 search queries.
 * 2. It sees the matching tasks as numbered titles with a snippet each, and picks which to load.
 *
 * The picked tasks' key parts are loaded up to the budget and go in front of the last three
 * exchanges. Choosing from a short titled list is the easiest judgement there is, which is why
 * this is two calls rather than one (brief, Q4) - it works on the weakest model o4c runs on.
 *
 * Both calls run with thinking off and a small output cap: they produce a few words each, and on
 * a `--parallel 1` local server every second they take is a second the real answer waits. Any
 * failure - a call erroring, an answer that cannot be read - falls back to sending no history at
 * all, which is the last three exchanges: never worse than a short `floating` window.
 */

export interface CuratedOptions {
  readonly complete: (request: CompletionRequest) => Promise<CompletionResponse>;
  readonly store: InfiniteContextStore;
  readonly retrieval: HistoryRetrieval;
  /** The task running now, so a fresh install with no other history skips both calls. */
  readonly currentTask: () => number | undefined;
}

/** Used when no budget can be worked out (an unknown window and no explicit token budget) - the
 * window is never guessed, so this is a small fixed allowance rather than a share of it. */
export const CURATED_FALLBACK_BUDGET_TOKENS = 8000;

const MAX_CANDIDATES = 12;

const QUERY_PROMPT =
  "You choose search terms for finding earlier work in a coding project's task history. " +
  'Reply with 1 to 3 short search queries, one per line, and nothing else. ' +
  'Prefer specific words: file names, function names, error messages, feature names.';

const PICK_PROMPT =
  'You choose which earlier tasks are worth loading as context for a new request in a coding project. ' +
  'Reply with the numbers of the tasks to load, most useful first, separated by commas - or NONE. ' +
  'Pick only tasks that would actually help with the new request.';

export async function curatedHistory(options: CuratedOptions, request: string, budgetTokens: number | undefined): Promise<string | undefined> {
  const { store, retrieval } = options;
  if (!store.hasTasksBefore(options.currentTask())) return undefined;

  try {
    const queries = await askForQueries(options, request);
    const candidates = mergeThreads(queries.map((q) => retrieval.rank(q, { limit: 8 })));
    if (candidates.length === 0) return undefined;
    const searchId = retrieval.record('curated', queries.join(' | '), candidates);

    const picked = await askForPicks(options, request, candidates);
    if (picked.length === 0) return undefined;
    if (searchId !== undefined) store.recordPicks(searchId, picked.map((t) => t.root.id));
    return assemble(store, picked, budgetTokens ?? CURATED_FALLBACK_BUDGET_TOKENS);
  } catch {
    return undefined;
  }
}

/** GBNF for the two side calls (llama-server only; others ignore it and the parsers below cope). */
export const QUERY_GRAMMAR = 'root ::= line ("\\n" line){0,2}\nline ::= [^\\n]{1,120}';
export const PICK_GRAMMAR = 'root ::= "none" | pick (", " pick){0,4}\npick ::= "#" [0-9]{1,8}';

async function askForQueries(options: CuratedOptions, request: string): Promise<string[]> {
  const response = await options.complete({
    systemPrompt: QUERY_PROMPT,
    messages: [{ role: 'user', content: request.slice(0, 4000) }],
    tools: [],
    maxTokens: 200,
    thinkLevel: 'nothink',
    purpose: 'side',
    // One to three short lines and nothing else (plan 0006 A12).
    grammar: QUERY_GRAMMAR,
  });
  const queries = response.content
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'`]|["'`]$/g, '').trim())
    .filter((line) => line.length > 0 && line.length <= 200)
    .slice(0, 3);
  // A reply with nothing usable in it still leaves the request itself to search on.
  return queries.length > 0 ? queries : [request];
}

/** Each thread once, at its best score across every query, best first. */
function mergeThreads(results: readonly RankedThread[][]): RankedThread[] {
  const best = new Map<number, RankedThread>();
  for (const thread of results.flat()) {
    const seen = best.get(thread.root.id);
    if (!seen || thread.score > seen.score) best.set(thread.root.id, thread);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

async function askForPicks(options: CuratedOptions, request: string, candidates: readonly RankedThread[]): Promise<RankedThread[]> {
  const listing = candidates.map((t) => {
    const answer = t.root.answer.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${t.number} ${t.root.title}${describeThread(t)}${answer ? ` - ${answer}` : ''}`;
  });
  const response = await options.complete({
    systemPrompt: PICK_PROMPT,
    messages: [{ role: 'user', content: `New request:\n${request.slice(0, 2000)}\n\nEarlier tasks:\n${listing.join('\n')}` }],
    tools: [],
    maxTokens: 100,
    thinkLevel: 'nothink',
    purpose: 'side',
    // "#n, #n" or "none" - nothing a reply can ramble in (plan 0006 A12).
    grammar: PICK_GRAMMAR,
  });
  const byId = new Map(candidates.map((t) => [t.root.id, t]));
  const picked: RankedThread[] = [];
  for (const match of response.content.matchAll(/#?(\d+)/g)) {
    const thread = byId.get(Number(match[1]));
    if (thread && !picked.includes(thread)) picked.push(thread);
  }
  return picked;
}

/** The picked tasks' key parts, in pick order, until the budget is spent. */
function assemble(store: InfiniteContextStore, picked: readonly RankedThread[], budgetTokens: number): string | undefined {
  const header = '[o4c history] Earlier tasks in this project, chosen as relevant to this request:';
  let used = estimateTextTokens(header);
  const parts: string[] = [];
  for (const thread of picked) {
    let text = formatTaskForContext(store, thread.root, thread.stale);
    const cost = estimateTextTokens(text);
    if (used + cost > budgetTokens) {
      // The first pick is cut to fit rather than dropped - it is the one the model wanted most.
      if (parts.length > 0) break;
      text = `${text.slice(0, Math.max(0, (budgetTokens - used) * 4))}... (cut to fit the budget)`;
    }
    parts.push(text);
    used += estimateTextTokens(text);
  }
  return parts.length > 0 ? [header, ...parts, '[end of earlier tasks]'].join('\n\n') : undefined;
}
