import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, seedLocalConfig } from '../session/configStore.js';
import { loadRules } from '../session/permissionRules.js';
import { resolveO4cMd } from '../session/projectContext.js';
import { findSolutionDir, SOLUTION_DIR } from '../session/solution.js';

function layout(): { root: string; home: string; solution: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'o4c-solution-'));
  const home = join(root, 'home');
  const solution = join(root, 'work', SOLUTION_DIR);
  const project = join(root, 'work', 'repo-a');
  for (const d of [home, solution, join(project, '.o4c')]) mkdirSync(d, { recursive: true });
  return { root, home, solution, project };
}

test('findSolutionDir finds the nearest .o4c-solution above the project, never the project itself', () => {
  const { root, solution, project } = layout();
  try {
    assert.equal(findSolutionDir(project), solution);
    assert.equal(findSolutionDir(join(project, 'nested', 'deeper')), solution);
    mkdirSync(join(project, SOLUTION_DIR));
    assert.equal(findSolutionDir(project), solution, 'a .o4c-solution inside the project does not count');
    assert.equal(findSolutionDir(undefined), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config resolves global < solution < local < personal, and rules add up across all four', async () => {
  const { root, home, solution, project } = layout();
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ a: 'global', b: 'global', c: 'global', permissions: { allow: ['g'] } }));
    writeFileSync(join(solution, 'config.json'), JSON.stringify({ b: 'solution', c: 'solution', permissions: { allow: ['s'] } }));
    writeFileSync(join(project, '.o4c', 'config.json'), JSON.stringify({ c: 'local' }));
    const store = new ConfigStore(project, home);
    assert.equal(store.hasScope('solution'), true);
    assert.equal(store.configPath('solution'), join(solution, 'config.json'));
    const merged = await store.resolve();
    assert.deepEqual([merged.a, merged.b, merged.c], ['global', 'solution', 'local']);
    const rules = await loadRules((sc) => store.readScope(sc as 'global'));
    assert.deepEqual(rules.allow.map((r) => `${r.scope}:${r.pattern}`), ['global:g', 'solution:s']);
    const none = new ConfigStore(project, home, [], null);
    assert.equal(none.hasScope('solution'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newly trusted project inside a solution is not seeded with a global snapshot', async () => {
  const { root, home, project } = layout();
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ b: 'global' }));
    await seedLocalConfig(project, home);
    assert.equal(existsSync(join(project, '.o4c', 'config.json')), false);
    await seedLocalConfig(project, home, { profile: 'x' });
    assert.equal(existsSync(join(project, '.o4c', 'config.json')), true, 'a chosen profile is still written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the solution's O4C.md is read between the global one and the project's", async () => {
  const { root, home, solution, project } = layout();
  try {
    writeFileSync(join(home, 'o4c.md'), 'GLOBAL RULES');
    writeFileSync(join(solution, 'O4C.md'), 'SOLUTION RULES');
    writeFileSync(join(project, 'O4C.md'), 'PROJECT RULES');
    const text = await resolveO4cMd(project, project, home);
    const [g, s, p] = ['GLOBAL RULES', 'SOLUTION RULES', 'PROJECT RULES'].map((t) => text.indexOf(t));
    assert.ok(g >= 0 && g < s && s < p, text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
