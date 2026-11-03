import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from './redact.js';
import { killTree } from '../tools/shellRunner.js';

/**
 * `/goal` (plan 0006 G5): a goal set on the session that o4c keeps working toward, turn after turn,
 * until a verifier says it is met or the budget is spent.
 *
 *   /goal make all the tests in test/ pass          set it (budget 10 turns)
 *   /goal budget 20 port the parser to the new API   set it with a budget
 *   /goal                                            show it
 *   /goal off                                        clear it
 *
 * The verifier, after every turn while the goal is active:
 * - with `goalVerifyCommand` in config (e.g. "npm test"), that command - exit 0 is met;
 * - without one, the model itself must say so: o4c sends a goal check ("verify the goal is fully
 *   met; if it is, reply starting GOAL MET, otherwise keep working") and only an answer starting
 *   GOAL MET ends it.
 * Not met: the next message is queued automatically (visible in the queue, never hidden) and one
 * turn of the budget is used. Kept in a small file per session so the per-turn reload keeps it.
 */
export interface Goal {
  text: string;
  status: 'active' | 'met' | 'budget';
  budget: number;
  turnsUsed: number;
  setAt: string;
}

export const GOAL_MET = 'GOAL MET';
export const DEFAULT_GOAL_BUDGET = 10;
export const GOAL_VERIFY_KEY = 'goalVerifyCommand';

export function goalsDir(projectRoot: string | undefined, home = homedir()): string {
  return projectRoot ? join(projectRoot, '.o4c', 'goals') : join(home, '.o4c', 'goals');
}

const fileFor = (dir: string, sessionId: string) => join(dir, `${sessionId.replace(/[^\w.-]+/g, '_')}.json`);

export function loadGoal(dir: string, sessionId: string | undefined): Goal | undefined {
  if (!sessionId) return undefined;
  try {
    return JSON.parse(readFileSync(fileFor(dir, sessionId), 'utf-8')) as Goal;
  } catch {
    return undefined;
  }
}

export function saveGoal(dir: string, sessionId: string, goal: Goal): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, sessionId), JSON.stringify(goal, null, 2), 'utf-8');
}

export function clearGoal(dir: string, sessionId: string): void {
  rmSync(fileFor(dir, sessionId), { force: true });
}

export type GoalCommand = { kind: 'show' } | { kind: 'off' } | { kind: 'set'; text: string; budget: number };

export function parseGoalCommand(arg: string): GoalCommand {
  const text = arg.trim();
  if (!text) return { kind: 'show' };
  if (/^(off|clear|stop)$/i.test(text)) return { kind: 'off' };
  const m = /^budget\s+(\d+)\s+([\s\S]+)$/i.exec(text);
  if (m) return { kind: 'set', text: m[2]!.trim(), budget: Math.max(1, Math.min(100, Number(m[1]))) };
  return { kind: 'set', text, budget: DEFAULT_GOAL_BUDGET };
}

export function describeGoal(goal: Goal | undefined): string {
  if (!goal) return 'No goal set. /goal <what done looks like> sets one; o4c then keeps working until it is verified or the budget (10 turns, or /goal budget N ...) is spent.';
  const state = goal.status === 'active' ? 'active' : goal.status === 'met' ? 'MET' : 'stopped - budget spent';
  return `Goal (${state}, ${goal.turnsUsed}/${goal.budget} turns): ${goal.text}`;
}

export function goalCheckMessage(goal: Goal): string {
  return `[Goal check] Verify that this goal is fully met - check it, do not assume: ${goal.text}\nIf it is fully met, reply starting with "${GOAL_MET}" and say how you verified it. If not, keep working on it now.`;
}

export function goalContinueMessage(goal: Goal, verifierOutput: string): string {
  return `[Goal] Not met yet - the verifier failed:\n${verifierOutput}\n\nKeep working toward the goal: ${goal.text}`;
}

/** The goal verify command's verdict: exit 0 is met; the output tail goes back to the model. Async, so
 * a test suite that takes minutes does not freeze the screen. */
export function runVerifyCommand(command: string, cwd = process.cwd(), timeoutMs = 10 * 60_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env: childEnv(), windowsHide: true });
    let output = '';
    const add = (d: Buffer) => {
      output += d.toString('utf-8');
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => killTree(child), timeoutMs);
    const done = (code: number | null, extra = '') => {
      clearTimeout(timer);
      const text = `${output}${extra}`.trim();
      const tail = text.length > 4000 ? `...\n${text.slice(-4000)}` : text;
      resolve({ ok: code === 0, output: `$ ${command} (exit ${code ?? 'none'})\n${tail}` });
    };
    child.on('error', (err) => done(null, err.message));
    child.on('close', (code) => done(code));
  });
}

/**
 * What happens after a turn while a goal is active. `reply` is the turn's final answer; `verifier`
 * the verify command's result when one is configured. Returns the updated goal, the message to
 * queue (if any), and a line for the user.
 */
export function afterTurn(goal: Goal, reply: string, verifier?: { ok: boolean; output: string }): { goal: Goal; next?: string; note: string } {
  const met = verifier ? verifier.ok : reply.trimStart().toUpperCase().startsWith(GOAL_MET);
  if (met) {
    return { goal: { ...goal, status: 'met' }, note: verifier ? `Goal met - the verifier passed. (${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'} used)` : `Goal met, by the model's own check. (${goal.turnsUsed} turns used)` };
  }
  if (goal.turnsUsed >= goal.budget) {
    return { goal: { ...goal, status: 'budget' }, note: `Goal not met and its budget of ${goal.budget} turns is spent - stopping. /goal shows it; /goal budget N <goal> starts again.` };
  }
  const next = verifier ? goalContinueMessage(goal, verifier.output) : goalCheckMessage(goal);
  return { goal: { ...goal, turnsUsed: goal.turnsUsed + 1 }, next, note: `Goal check ${goal.turnsUsed + 1}/${goal.budget}: ${verifier ? 'the verifier failed - continuing.' : 'asking the model to verify it.'}` };
}
