import { AbortedError, AgentLoop, type AgentEvent } from '../../agent/loop.js';
import { aiResponseEntry, userInputEntry, type ContextEntry } from '../../agent/contextEntry.js';
import type { Tool } from '../../tools/types.js';
import {
  ScriptedProvider,
  plainText,
  tagged,
  type ScriptRound,
  type SummarizerMode,
} from './scriptedProvider.js';
import type { ProviderStats } from './scriptedProvider.js';
import type { Violation } from './invariants.js';

export interface TurnSpec {
  prompt: string;
  rounds: ScriptRound[];
  /** Gives the turn an AbortController; a round with `abortDuring` cancels it. */
  abortable?: boolean;
}

export interface ScenarioSpec {
  name: string;
  /** Overrides the default window matrix (for example, overhead cases only at small windows). */
  windows?: number[];
  drift?: number;
  summarizer?: SummarizerMode;
  extraTools?: number;
  systemPromptTokens?: (window: number) => number;
  /** Seeds a resumed session with `pairs` user/response exchanges of `tokensEach` tokens per entry. */
  preload?: (window: number) => { pairs: number; tokensEach: number };
  build: (window: number) => TurnSpec[];
  check?: (result: ScenarioResult) => void;
}

export interface TurnResult {
  prompt: string;
  outcome: 'text' | 'empty' | 'aborted' | 'error';
  text: string;
  warnings: string[];
  error?: string;
}

export interface ScenarioResult {
  name: string;
  window: number;
  turns: TurnResult[];
  violations: Violation[];
  events: AgentEvent[];
  finalEntries: readonly ContextEntry[];
  stats: ProviderStats;
  compactions: number;
  prunes: number;
  hardStops: number;
  requests: number;
}

const DEFAULT_SYSTEM_PROMPT = 'You are a coding agent under test.';

function makeTools(provider: ScriptedProvider, extra: number): Tool[] {
  const schema = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } };
  const sized = (name: string, mutating: boolean, description: string): Tool => ({
    name,
    description,
    mutating,
    inputSchema: schema,
    async execute() {
      return tagged(provider.tags.next(), provider.resultQueue.shift() ?? 0);
    },
  });
  const tools: Tool[] = [
    sized('read_file', false, 'Read a file from the workspace.'),
    sized('write_file', true, 'Write a file in the workspace.'),
  ];
  for (let i = 0; i < extra; i++) {
    tools.push(sized(`extra_tool_${i}`, false, `Extra tool ${i}. ${'Describes its parameters in detail. '.repeat(8)}`));
  }
  return tools;
}

export async function runScenario(spec: ScenarioSpec, window: number): Promise<ScenarioResult> {
  const provider = new ScriptedProvider({
    window,
    drift: spec.drift ?? 1,
    summarizer: spec.summarizer ?? 'ok',
  });
  const systemPrompt = spec.systemPromptTokens
    ? plainText(spec.systemPromptTokens(window)) || DEFAULT_SYSTEM_PROMPT
    : DEFAULT_SYSTEM_PROMPT;
  const loop = new AgentLoop(provider, makeTools(provider, spec.extraTools ?? 0), systemPrompt);
  provider.attach(loop);

  if (spec.preload) {
    const { pairs, tokensEach } = spec.preload(window);
    const preloaded: ContextEntry[] = [];
    for (let i = 0; i < pairs; i++) {
      preloaded.push(userInputEntry(tagged(provider.tags.next(), tokensEach)));
      preloaded.push(aiResponseEntry(tagged(provider.tags.next(), tokensEach)));
    }
    for (const entry of preloaded) provider.noteEntry(entry);
    loop.loadEntries(preloaded);
  }

  const turns: TurnResult[] = [];
  const events: AgentEvent[] = [];
  for (const turn of spec.build(window)) {
    provider.script = turn.rounds;
    provider.cursor = 0;
    const controller = turn.abortable ? new AbortController() : undefined;
    provider.abortController = controller;
    const turnEvents: AgentEvent[] = [];
    const result: TurnResult = { prompt: turn.prompt, outcome: 'text', text: '', warnings: [] };
    try {
      result.text = await loop.run(turn.prompt, {
        contextWindow: window,
        maxIterations: 500,
        signal: controller?.signal,
        onEvent: (event) => turnEvents.push(event),
        onEntry: (entry) => provider.noteEntry(entry),
      });
      result.outcome = result.text ? 'text' : 'empty';
    } catch (err) {
      if (err instanceof AbortedError) {
        result.outcome = 'aborted';
      } else {
        result.outcome = 'error';
        result.error = err instanceof Error ? err.message : String(err);
        provider.violate('no-crash', result.error);
      }
    }
    result.warnings = turnEvents.filter((e) => e.type === 'warning').map((e) => e.text ?? '');
    if (result.outcome === 'empty' && result.warnings.length === 0) {
      provider.violate('turn-not-silent', `turn "${turn.prompt}" ended with no text and no warning`);
    }
    events.push(...turnEvents);
    turns.push(result);
    if (provider.violations.length > 0) break;
  }

  return {
    name: spec.name,
    window,
    turns,
    violations: provider.violations,
    events,
    finalEntries: loop.getEntries(),
    stats: provider.stats,
    compactions: events.filter((e) => e.type === 'compaction').length,
    prunes: events.filter((e) => e.type === 'prune').length,
    hardStops: events.filter((e) => e.type === 'warning' && (e.text ?? '').includes('nearly full')).length,
    requests: provider.stats.requests,
  };
}

export function formatReport(r: ScenarioResult): string {
  const status = r.violations.length === 0 ? 'PASS' : 'FAIL';
  const last = r.turns[r.turns.length - 1];
  const stop = last ? (r.hardStops > 0 ? 'hard-stop' : last.outcome) : 'none';
  return [
    `${r.name.padEnd(30)} W=${String(r.window).padStart(6)}`,
    status,
    `peak=${Math.round(r.stats.peakFraction * 100)}%`,
    `compactions=${r.compactions}`,
    `prunes=${r.prunes}`,
    `hardStops=${r.hardStops}`,
    `capHits=${r.stats.capHits}`,
    `overrun=${r.stats.overrun}`,
    `summarizerOver=${r.stats.summarizerOverWindow}`,
    `requests=${r.requests}`,
    `stop=${stop}`,
  ].join(' ');
}
