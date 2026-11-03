import type { SessionSpend, TokenSpend } from '../session/usageStore.js';
import { cacheSharePercent } from './statusBar.js';

/**
 * `/stats` (plan 0006 E11): what this session, this project and this machine have used - tokens,
 * cache share, active time, requests, tasks and tool calls. No model call. Tasks come from
 * history.db (cli.ts sets the source), so an untrusted folder without one just leaves them out.
 */
export interface TaskCounts {
  total: number;
  done: number;
  worked: number;
}

let taskSource: (() => TaskCounts) | undefined;

export function setTaskCountSource(next: (() => TaskCounts) | undefined): void {
  taskSource = next;
}

export function taskCounts(): TaskCounts | undefined {
  try {
    return taskSource?.();
  } catch {
    return undefined;
  }
}

export interface StatsInput {
  session: SessionSpend;
  project?: TokenSpend;
  machine?: TokenSpend;
  turns: number;
  toolCalls: number;
  tasks?: TaskCounts;
  /** E19: what the session cost at the registry price for this model, when it has one. */
  cost?: { session: number; model: string };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

const tok = (t: TokenSpend) => `${t.input.toLocaleString()} prompt / ${t.output.toLocaleString()} generated`;

export function formatStats(s: StatsInput): string[] {
  const cache = cacheSharePercent(s.session.cached, s.session.processed);
  const rate = s.session.activeMs > 0 ? ` (${Math.round(s.session.output / (s.session.activeMs / 1000))} generated/s over active time)` : '';
  return [
    'Stats (local, no model call):',
    `  Session:  ${tok(s.session)}`,
    `            ${s.session.requests.toLocaleString()} requests, ${s.turns} of your messages, ${s.toolCalls} tool calls`,
    `            cache ${cache === undefined ? 'n/a' : `${cache}%`} of prompt tokens; active ${formatDuration(s.session.activeMs)}${rate}`,
    ...(s.project ? [`  Project:  ${tok(s.project)}`] : ['  Project:  not counted (this folder is not a trusted project)']),
    ...(s.machine ? [`  Machine:  ${tok(s.machine)} (every project on this computer)`] : []),
    ...(s.cost ? [`  Cost:     about $${s.cost.session.toFixed(s.cost.session < 1 ? 4 : 2)} this session (registry price for ${s.cost.model}, /view-model)`] : []),
    ...(s.tasks ? [`  Tasks:    ${s.tasks.total} in this project, ${s.tasks.done} finished, ${s.tasks.worked} marked as worked (/worked)`] : []),
  ];
}
