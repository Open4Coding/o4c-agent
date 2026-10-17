import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPlanNumber,
  listPlans,
  nextPlanNumber,
  plansReport,
  type PlansListing,
} from '../session/plansStore.js';

/**
 * `.o4c/plans/` browsing - front-end checklist item 10's reading half.
 *
 * Writing was never the gap: Plan-Write mode already permits `write_file` scoped to this exact
 * directory. What was missing is knowing what is there, which is what these cover.
 */

async function project(files: readonly string[]): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'o4c-plans-'));
  await mkdir(join(root, '.o4c', 'plans'), { recursive: true });
  for (const name of files) {
    await writeFile(join(root, '.o4c', 'plans', name), `# ${name}\n`);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('groups the three files of one plan into a single entry', async () => {
  const { root, cleanup } = await project([
    '0001.FrontEnd.plan.md',
    '0001.FrontEnd.checklist.md',
    '0001.FrontEnd.planningsession.md',
  ]);
  try {
    const listing = await listPlans(root);
    assert.equal(listing.plans.length, 1, 'three files of one plan are one plan');
    assert.equal(listing.plans[0].name, 'FrontEnd');
    assert.equal(listing.plans[0].number, 1);
    assert.equal(listing.plans[0].prefix, '0001');
    // Always plan, checklist, planningsession - not readdir order, which is arbitrary.
    assert.deepEqual(
      listing.plans[0].files.map((f) => f.kind),
      ['plan', 'checklist', 'planningsession'],
    );
  } finally {
    await cleanup();
  }
});

test('a plan with only some of its files is listed with just those', async () => {
  // The difference a glance at /plans is mostly for: a plan with no checklist yet.
  const { root, cleanup } = await project(['0002.Alone.plan.md']);
  try {
    const listing = await listPlans(root);
    assert.deepEqual(listing.plans[0].files.map((f) => f.kind), ['plan']);
  } finally {
    await cleanup();
  }
});

test('plans sort numerically, not lexicographically', async () => {
  // '10' before '9' is what a string sort would give, and it is wrong.
  const { root, cleanup } = await project([
    '0009.Nine.plan.md',
    '0010.Ten.plan.md',
    '0002.Two.plan.md',
  ]);
  try {
    const listing = await listPlans(root);
    assert.deepEqual(listing.plans.map((p) => p.number), [2, 9, 10]);
  } finally {
    await cleanup();
  }
});

test('files that do not fit the convention are reported, not silently dropped', async () => {
  // The likeliest cause is a typo in a name just written, and a plan that exists but does not
  // appear is worse than one that appears with a complaint attached.
  const { root, cleanup } = await project([
    '0001.Good.plan.md',
    'notes.md',
    '1.Bad.plan.txt',
    'README',
    '0003.NoKind.md',
  ]);
  try {
    const listing = await listPlans(root);
    assert.deepEqual(listing.plans.map((p) => p.name), ['Good']);
    assert.deepEqual(listing.unrecognised, ['0003.NoKind.md', '1.Bad.plan.txt', 'README', 'notes.md']);
  } finally {
    await cleanup();
  }
});

test('a name containing dots still parses, since the kind is the last segment', async () => {
  const { root, cleanup } = await project(['0004.v1.2.Release.plan.md']);
  try {
    const listing = await listPlans(root);
    assert.equal(listing.plans.length, 1);
    assert.equal(listing.plans[0].name, 'v1.2.Release');
  } finally {
    await cleanup();
  }
});

test('two plans sharing a number but not a name are kept apart', async () => {
  // The convention forbids it; a directory can still end up this way, and merging them would
  // misreport both.
  const { root, cleanup } = await project(['0001.First.plan.md', '0001.Second.plan.md']);
  try {
    const listing = await listPlans(root);
    assert.equal(listing.plans.length, 2);
    assert.deepEqual(listing.plans.map((p) => p.name), ['First', 'Second']);
  } finally {
    await cleanup();
  }
});

test('a missing directory, an untrusted project and an empty directory are all empty listings', async () => {
  // /plans is informational: it must degrade to "there are none" rather than being the one command
  // that errors out.
  assert.deepEqual(await listPlans(undefined), { plans: [], unrecognised: [] });

  const noDir = await mkdtemp(join(tmpdir(), 'o4c-noplans-'));
  try {
    assert.deepEqual(await listPlans(noDir), { plans: [], unrecognised: [] });
  } finally {
    await rm(noDir, { recursive: true, force: true });
  }

  const { root, cleanup } = await project([]);
  try {
    assert.deepEqual(await listPlans(root), { plans: [], unrecognised: [] });
  } finally {
    await cleanup();
  }
});

test('nextPlanNumber is one past the highest present, derived from disk', async () => {
  assert.equal(nextPlanNumber({ plans: [], unrecognised: [] }), 1);
  const { root, cleanup } = await project(['0001.A.plan.md', '0007.B.plan.md', '0003.C.plan.md']);
  try {
    assert.equal(nextPlanNumber(await listPlans(root)), 8, 'the highest, not the count');
  } finally {
    await cleanup();
  }
});

test('formatPlanNumber pads to four digits and does not truncate beyond them', () => {
  assert.equal(formatPlanNumber(1), '0001');
  assert.equal(formatPlanNumber(42), '0042');
  assert.equal(formatPlanNumber(1234), '1234');
  assert.equal(formatPlanNumber(12345), '12345');
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const empty: PlansListing = { plans: [], unrecognised: [] };

test('with no project the report says so rather than "no plans"', () => {
  const lines = plansReport(empty, false);
  assert.ok(lines[0].includes('No project'), lines[0]);
  // Still names the path, so the user learns where plans would live.
  assert.ok(lines.join('\n').includes('.o4c/plans/'));
});

test('with no plans the report names the path, the naming rule and how to create one', () => {
  // "No plans" is indistinguishable from "o4c cannot do plans" unless all three are said.
  const text = plansReport(empty, true).join('\n');
  assert.ok(text.includes('.o4c/plans/'), text);
  assert.ok(text.includes('NNNN.Name.plan.md'), text);
  assert.ok(text.includes('Plan-Write'), text);
});

test('the report lists each plan with the file kinds it actually has', async () => {
  const { root, cleanup } = await project([
    '0001.FrontEnd.plan.md',
    '0001.FrontEnd.checklist.md',
    '0002.Solo.plan.md',
  ]);
  try {
    const lines = plansReport(await listPlans(root), true);
    assert.equal(lines[0], 'Plans:');
    assert.equal(lines[1], '  0001.FrontEnd - plan, checklist');
    assert.equal(lines[2], '  0002.Solo - plan');
  } finally {
    await cleanup();
  }
});

test('the report surfaces unrecognised files under their own heading', async () => {
  const { root, cleanup } = await project(['0001.Good.plan.md', 'stray.md']);
  try {
    const text = plansReport(await listPlans(root), true).join('\n');
    assert.ok(text.includes('Not recognised'), text);
    assert.ok(text.includes('stray.md'), text);
  } finally {
    await cleanup();
  }
});
