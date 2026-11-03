import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '../tools/types.js';

/**
 * Skills (plan 0006 G2, 0002 item 39): a folder with a `SKILL.md` - instructions for one kind of
 * job, plus any files they refer to - that the model loads when the job comes up.
 *
 *   .o4c/skills/<name>/SKILL.md      this project
 *   ~/.o4c/skills/<name>/SKILL.md    every project
 *   <o4c>/skills/<name>/SKILL.md     bundled: review, security-review, commit
 *
 * SKILL.md frontmatter: `name`, `description` (one line - it is what the model chooses by), and
 * optionally `allowed-tools`, the only tools the model may use while the skill is active. Project
 * beats global beats bundled for the same name.
 *
 * Cache discipline: the listing (one capped line per skill) goes into the system prompt, built once
 * per session, and the body arrives as a tool result or folded into the user's message - so neither
 * the system prompt nor the tool list ever changes mid-session.
 */
export interface Skill {
  name: string;
  description: string;
  allowedTools?: string[];
  body: string;
  dir: string;
  scope: 'project' | 'global' | 'bundled';
}

export const MAX_LISTED_SKILLS = 30;
const MAX_DESCRIPTION = 160;

export function bundledSkillsDir(): string {
  // src/session or dist/session -> the package root's skills/.
  return fileURLToPath(new URL('../../skills', import.meta.url));
}

export function parseSkillFile(text: string): { name?: string; description?: string; allowedTools?: string[]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  const tools = meta['allowed-tools']
    ?.replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return { name: meta.name, description: meta.description, ...(tools?.length ? { allowedTools: tools } : {}), body: m[2]!.trim() };
}

function readSkills(root: string, scope: Skill['scope']): Skill[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const n of names.sort()) {
    const dir = join(root, n);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const parsed = parseSkillFile(readFileSync(join(dir, 'SKILL.md'), 'utf-8'));
      const name = (parsed.name ?? n).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!name || !parsed.body) continue;
      out.push({ name, description: (parsed.description ?? `Skill in ${dir}`).slice(0, MAX_DESCRIPTION), allowedTools: parsed.allowedTools, body: parsed.body, dir, scope });
    } catch {
      // No SKILL.md: not a skill.
    }
  }
  return out;
}

export function loadSkills(projectRoot: string | undefined, home = homedir(), bundled = bundledSkillsDir()): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of readSkills(bundled, 'bundled')) byName.set(s.name, s);
  for (const s of readSkills(join(home, '.o4c', 'skills'), 'global')) byName.set(s.name, s);
  if (projectRoot) for (const s of readSkills(join(projectRoot, '.o4c', 'skills'), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The system prompt's skills section: one line each, capped. */
export function skillListing(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const shown = skills.slice(0, MAX_LISTED_SKILLS);
  return [
    '# Skills',
    'Instructions for particular jobs. When a request matches one, load it with the skill tool first and follow it.',
    ...shown.map((s) => `- ${s.name}: ${s.description}`),
    ...(skills.length > shown.length ? [`(${skills.length - shown.length} more - the skill tool lists them all)`] : []),
  ].join('\n');
}

let registry: readonly Skill[] = [];
let active: { name: string; allowedTools?: string[] } | undefined;

export function setSkills(skills: readonly Skill[]): void {
  registry = skills;
}

export function getSkills(): readonly Skill[] {
  return registry;
}

export function findSkill(name: string): Skill | undefined {
  const n = name.trim().toLowerCase().replace(/^\//, '');
  return registry.find((s) => s.name === n);
}

/** A skill is active from when it is loaded until the turn ends (`clearActiveSkill`). */
export function activateSkill(skill: Skill): void {
  active = { name: skill.name, allowedTools: skill.allowedTools };
}

export function clearActiveSkill(): void {
  active = undefined;
}

export function activeSkill(): { name: string; allowedTools?: string[] } | undefined {
  return active;
}

/** Why `toolName` is not allowed right now, or undefined. The skill tool itself is always allowed. */
export function skillGate(toolName: string): string | undefined {
  if (!active?.allowedTools || toolName === 'skill' || active.allowedTools.includes(toolName)) return undefined;
  return `the active skill "${active.name}" allows only ${active.allowedTools.join(', ')}`;
}

/** The skill's text and the files that came with it, as the model sees it. */
export function skillText(skill: Skill): string {
  let files: string[] = [];
  try {
    files = listFiles(skill.dir).filter((f) => f !== 'SKILL.md');
  } catch {
    files = [];
  }
  return [
    `Skill "${skill.name}" (${skill.scope}, ${skill.dir}) - follow it for this task.`,
    ...(skill.allowedTools ? [`While it is active you may use only: ${skill.allowedTools.join(', ')}.`] : []),
    '',
    skill.body,
    ...(files.length ? ['', `Files that come with it (read them with read_file when the instructions point to them):`, ...files.map((f) => `- ${join(skill.dir, f)}`)] : []),
  ].join('\n');
}

function listFiles(dir: string, root = dir, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, root, depth + 1));
    else out.push(relative(root, p));
  }
  return out.slice(0, 50);
}

export const skillTool: Tool = {
  name: 'skill',
  description: 'Load a skill (listed under Skills in the system prompt) and follow its instructions. Input: the skill name.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill to load.' } },
    required: ['name'],
  },
  async execute(input) {
    const name = typeof input.name === 'string' ? input.name : '';
    const skill = findSkill(name);
    if (!skill) {
      const names = registry.map((s) => s.name);
      return `No skill "${name}". ${names.length ? `Skills: ${names.join(', ')}.` : 'No skills are installed.'}`;
    }
    activateSkill(skill);
    return skillText(skill);
  },
};
