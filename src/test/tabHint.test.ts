import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_HINT_RUNS,
  TAB_HINT_RUNS_KEY,
  TAB_USED_KEY,
  decideTabHint,
} from '../ui/tabHint.js';

// Front-end checklist #11. The policy is tested here rather than through cli.ts, which has no test
// harness - and the two failure modes a tip has are both silent: never appearing, or never leaving.

test('a config that has never seen o4c shows the tip and counts the run', () => {
  assert.deepEqual(decideTabHint({}, false), { show: true, recordRuns: 1 });
});

test('the tip retires the moment Tab has actually been used, however few runs it has had', () => {
  assert.deepEqual(decideTabHint({ [TAB_USED_KEY]: true }, false), { show: false });
  assert.deepEqual(decideTabHint({ [TAB_USED_KEY]: true, [TAB_HINT_RUNS_KEY]: 0 }, false), { show: false });
});

test('the tip retires on its own after the run allowance, for somebody who only uses /mode', () => {
  for (let runs = 0; runs < TAB_HINT_RUNS; runs++) {
    assert.equal(decideTabHint({ [TAB_HINT_RUNS_KEY]: runs }, false).show, true, `run ${runs}`);
  }
  assert.deepEqual(decideTabHint({ [TAB_HINT_RUNS_KEY]: TAB_HINT_RUNS }, false), { show: false });
  // A count past the allowance (a hand-edited file, or an allowance lowered later) stays retired
  // rather than wrapping back around.
  assert.deepEqual(decideTabHint({ [TAB_HINT_RUNS_KEY]: 99 }, false), { show: false });
});

// The distinction the whole module exists for: the end-of-turn repaint and /resume both relaunch
// the process, so counting those would burn the allowance inside one session.
test('a resumed launch still shows the tip but does not spend a run', () => {
  assert.deepEqual(decideTabHint({}, true), { show: true, recordRuns: undefined });
  assert.deepEqual(decideTabHint({ [TAB_HINT_RUNS_KEY]: 1 }, true), { show: true, recordRuns: undefined });
});

test('a resumed launch cannot revive a tip that has already retired', () => {
  assert.deepEqual(decideTabHint({ [TAB_USED_KEY]: true }, true), { show: false });
  assert.deepEqual(decideTabHint({ [TAB_HINT_RUNS_KEY]: TAB_HINT_RUNS }, true), { show: false });
});

// config.json is hand-editable, and both directions matter: garbage must not make the tip
// permanent, and must not silently suppress it either. NaN is the one that bites - it fails every
// comparison, so an unguarded `runs < TAB_HINT_RUNS` would hide the tip forever.
test('a nonsense run count reads as no runs yet rather than as retired', () => {
  for (const raw of [NaN, -1, 1.5, '2', null, {}, [], true]) {
    assert.deepEqual(
      decideTabHint({ [TAB_HINT_RUNS_KEY]: raw }, false),
      { show: true, recordRuns: 1 },
      `${String(raw)} should read as zero runs`,
    );
  }
});

test('only a literal true retires the tip, not any truthy value', () => {
  // So a stray `"false"` or `1` in a hand-edited config cannot switch off a teaching aid by
  // accident - the key is written by us, as a boolean, or it does not count.
  assert.equal(decideTabHint({ [TAB_USED_KEY]: 'yes' }, false).show, true);
  assert.equal(decideTabHint({ [TAB_USED_KEY]: 1 }, false).show, true);
});
