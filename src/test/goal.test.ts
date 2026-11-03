import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterTurn, clearGoal, describeGoal, GOAL_MET, loadGoal, parseGoalCommand, runVerifyCommand, saveGoal, type Goal } from '../session/goal.js';

const goal = (over: Partial<Goal> = {}): Goal => ({ text: 'all tests pass', status: 'active', budget: 3, turnsUsed: 0, setAt: 't', ...over });

test('parseGoalCommand: show, off, set, set with a budget (clamped)', () => {
  assert.deepEqual(parseGoalCommand(''), { kind: 'show' });
  assert.deepEqual(parseGoalCommand(' off '), { kind: 'off' });
  assert.deepEqual(parseGoalCommand('make it fast'), { kind: 'set', text: 'make it fast', budget: 10 });
  assert.deepEqual(parseGoalCommand('budget 4 port the parser'), { kind: 'set', text: 'port the parser', budget: 4 });
  assert.deepEqual(parseGoalCommand('budget 999 x'), { kind: 'set', text: 'x', budget: 100 });
});

test('without a verify command the model must answer GOAL MET; otherwise a check is queued until the budget runs out', () => {
  const first = afterTurn(goal(), 'I changed three files.');
  assert.equal(first.goal.turnsUsed, 1);
  assert.match(first.next ?? '', /\[Goal check\] Verify that this goal is fully met.*all tests pass[\s\S]*GOAL MET/);
  assert.match(first.note, /Goal check 1\/3/);
  const met = afterTurn(first.goal, `${GOAL_MET} - ran npm test, 42 passing.`);
  assert.equal(met.goal.status, 'met');
  assert.equal(met.next, undefined);
  const spent = afterTurn(goal({ turnsUsed: 3 }), 'still working');
  assert.equal(spent.goal.status, 'budget');
  assert.equal(spent.next, undefined);
  assert.match(spent.note, /budget of 3 turns is spent/);
});

test('with a verify command its exit code decides, and a failure sends its output back', () => {
  const fail = afterTurn(goal(), 'GOAL MET (the model claims)', { ok: false, output: '$ npm test (exit 1)\n2 failing' });
  assert.equal(fail.goal.status, 'active', "the model's claim does not override the verifier");
  assert.match(fail.next ?? '', /\[Goal\] Not met yet - the verifier failed:\n\$ npm test \(exit 1\)\n2 failing/);
  assert.equal(afterTurn(goal(), 'done', { ok: true, output: '' }).goal.status, 'met');
});

test('runVerifyCommand reports exit codes and output', async () => {
  const ok = await runVerifyCommand('node -e "console.log(42)"');
  assert.equal(ok.ok, true);
  assert.match(ok.output, /exit 0\)\n42/);
  const bad = await runVerifyCommand('node -e "process.exit(3)"');
  assert.equal(bad.ok, false);
  assert.match(bad.output, /exit 3/);
});

test('goals are saved per session and survive a reload; describeGoal says where it stands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-goal-'));
  try {
    assert.equal(loadGoal(dir, 's1'), undefined);
    assert.match(describeGoal(undefined), /No goal set/);
    saveGoal(dir, 's1', goal({ turnsUsed: 2 }));
    assert.equal(loadGoal(dir, 's1')!.turnsUsed, 2);
    assert.equal(loadGoal(dir, 's2'), undefined);
    assert.equal(describeGoal(loadGoal(dir, 's1')), 'Goal (active, 2/3 turns): all tests pass');
    clearGoal(dir, 's1');
    assert.equal(loadGoal(dir, 's1'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
