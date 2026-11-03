import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeSkill,
  bundledSkillsDir,
  clearActiveSkill,
  loadSkills,
  MAX_LISTED_SKILLS,
  parseSkillFile,
  setSkills,
  skillGate,
  skillListing,
  skillTool,
  type Skill,
} from '../session/skills.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { defaultTools } from '../tools/index.js';

afterEach(() => {
  clearActiveSkill();
  setSkills([]);
});

function skillDir(root: string, name: string, text: string, extra?: Record<string, string>): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), text);
  for (const [f, body] of Object.entries(extra ?? {})) writeFileSync(join(root, name, f), body);
}

test('the three bundled skills load, with descriptions and allowed tools', () => {
  const skills = loadSkills(undefined, mkdtempSync(join(tmpdir(), 'o4c-skills-home-')), bundledSkillsDir());
  assert.deepEqual(skills.map((s) => s.name), ['commit', 'review', 'security-review']);
  for (const s of skills) {
    assert.equal(s.scope, 'bundled');
    assert.ok(s.description.length > 20);
    assert.ok(s.allowedTools && s.allowedTools.length > 0);
  }
  assert.ok(!skills.find((s) => s.name === 'review')!.allowedTools!.includes('write_file'), 'review is read-only');
});

test('project beats global beats bundled; a folder without SKILL.md is not a skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-skills-'));
  try {
    const bundled = join(root, 'bundled');
    const home = join(root, 'home');
    const project = join(root, 'proj');
    skillDir(bundled, 'review', '---\ndescription: bundled review\n---\nbundled body');
    skillDir(join(home, '.o4c', 'skills'), 'review', '---\ndescription: global review\n---\nglobal body');
    skillDir(join(project, '.o4c', 'skills'), 'review', '---\ndescription: project review\n---\nproject body');
    skillDir(join(project, '.o4c', 'skills'), 'deploy', '---\nname: Deploy\ndescription: ship it\nallowed-tools: [run_shell]\n---\nsteps', { 'checklist.md': 'x' });
    mkdirSync(join(project, '.o4c', 'skills', 'empty'), { recursive: true });
    const skills = loadSkills(project, home, bundled);
    assert.deepEqual(skills.map((s) => `${s.name}:${s.scope}`), ['deploy:project', 'review:project']);
    assert.deepEqual(skills[0]!.allowedTools, ['run_shell']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseSkillFile reads frontmatter; a file without it is all body', () => {
  assert.deepEqual(parseSkillFile('---\nname: x\ndescription: "d"\nallowed-tools: read_file, grep\n---\nbody'), { name: 'x', description: 'd', allowedTools: ['read_file', 'grep'], body: 'body' });
  assert.deepEqual(parseSkillFile('plain'), { body: 'plain' });
});

test('the listing is one line per skill, capped, and goes into the system prompt as its own section', () => {
  const many: Skill[] = Array.from({ length: MAX_LISTED_SKILLS + 3 }, (_, i) => ({ name: `s${i}`, description: `does ${i}`, body: 'b', dir: '/d', scope: 'global' }));
  const listing = skillListing(many)!;
  assert.match(listing, /^# Skills\n/);
  assert.match(listing, /- s0: does 0/);
  assert.match(listing, /\(3 more - the skill tool lists them all\)/);
  assert.equal(skillListing([]), undefined);
  const prompt = buildSystemPrompt({ profile: 'default', tools: ['read_file'], environment: [], skills: skillListing(many.slice(0, 2)) });
  assert.match(prompt, /# Skills[\s\S]*- s1: does 1/);
});

test('the skill tool loads a skill, lists its files, activates its allowed-tools; the gate enforces them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-skills-'));
  try {
    skillDir(root, 'deploy', '---\ndescription: ship it\nallowed-tools: run_shell, read_file\n---\nRun the deploy.', { 'notes.md': 'n' });
    setSkills(loadSkills(undefined, join(root, 'nohome'), root));
    assert.ok(defaultTools.some((t) => t.name === 'skill'), 'the tool is in the fixed tool list');
    const out = await skillTool.execute({ name: 'deploy' });
    assert.match(out, /Skill "deploy" .* follow it for this task/);
    assert.match(out, /you may use only: run_shell, read_file/);
    assert.match(out, /notes\.md/);
    assert.equal(activeSkill()?.name, 'deploy');
    assert.equal(skillGate('read_file'), undefined);
    assert.equal(skillGate('skill'), undefined);
    assert.match(skillGate('write_file') ?? '', /active skill "deploy" allows only run_shell, read_file/);
    clearActiveSkill();
    assert.equal(skillGate('write_file'), undefined);
    assert.match(await skillTool.execute({ name: 'nope' }), /No skill "nope"\. Skills: deploy\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every bundled skill names only real tools in allowed-tools', () => {
  const real = new Set([...defaultTools.map((t) => t.name), 'code_graph']);
  for (const s of loadSkills(undefined, mkdtempSync(join(tmpdir(), 'o4c-skills-home-')), bundledSkillsDir())) {
    for (const t of s.allowedTools ?? []) assert.ok(real.has(t), `${s.name}: "${t}" is not a tool`);
  }
});
