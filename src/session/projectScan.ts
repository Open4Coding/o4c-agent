import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from '../tools/searchUtils.js';
import { languageForPath } from '../graph/languages.js';
import { instructionFileIn } from './instructionFiles.js';

/**
 * What `/init` learns about a project without asking the model (plan 0006 D2): its languages, the
 * commands its own files declare for building and testing, and its top-level layout. Enough for a
 * first O4C.md the user then corrects - every line of it comes from a file in the project.
 */
export interface ProjectScan {
  languages: Array<{ id: string; files: number }>;
  commands: Array<{ what: string; command: string; from: string }>;
  topDirs: string[];
  /** AGENTS.md / CLAUDE.md already there (O4C.md would hide them, so the draft imports them). */
  existingInstructions?: string;
}

const COMMAND_SCRIPTS: ReadonlyArray<[string, string]> = [
  ['test', 'Test'],
  ['build', 'Build'],
  ['lint', 'Lint'],
  ['typecheck', 'Type-check'],
  ['check', 'Check'],
  ['dev', 'Run (dev)'],
  ['start', 'Run'],
  ['format', 'Format'],
];

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

export async function scanProject(root: string): Promise<ProjectScan> {
  const { entries } = await walkFiles(root);
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const lang = languageForPath(e.path);
    if (lang) counts.set(lang.id, (counts.get(lang.id) ?? 0) + 1);
  }
  const languages = [...counts.entries()].map(([id, files]) => ({ id, files })).sort((a, b) => b.files - a.files).slice(0, 6);

  const commands: ProjectScan['commands'] = [];
  const pkg = read(join(root, 'package.json'));
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      const runner = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm';
      for (const [script, what] of COMMAND_SCRIPTS) {
        if (scripts[script]) commands.push({ what, command: runner === 'npm' && script !== 'test' && script !== 'start' ? `npm run ${script}` : `${runner} ${script}`, from: 'package.json' });
      }
    } catch {
      // unparseable package.json: no commands from it
    }
  }
  const pyproject = read(join(root, 'pyproject.toml')) ?? '';
  if (pyproject || existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'setup.py'))) {
    const usesPytest = /pytest/.test(pyproject + (read(join(root, 'requirements.txt')) ?? '')) || existsSync(join(root, 'tests')) || existsSync(join(root, 'pytest.ini'));
    commands.push({ what: 'Test', command: usesPytest ? 'python -m pytest' : 'python -m unittest', from: pyproject ? 'pyproject.toml' : 'requirements.txt / setup.py' });
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    commands.push({ what: 'Build', command: 'cargo build', from: 'Cargo.toml' }, { what: 'Test', command: 'cargo test', from: 'Cargo.toml' });
  }
  if (existsSync(join(root, 'go.mod'))) {
    commands.push({ what: 'Build', command: 'go build ./...', from: 'go.mod' }, { what: 'Test', command: 'go test ./...', from: 'go.mod' });
  }
  const makefile = read(join(root, 'Makefile'));
  if (makefile) {
    for (const target of ['test', 'build', 'lint', 'check']) {
      if (new RegExp(`^${target}\\s*:`, 'm').test(makefile) && !commands.some((c) => c.command.endsWith(` ${target}`))) {
        commands.push({ what: target[0]!.toUpperCase() + target.slice(1), command: `make ${target}`, from: 'Makefile' });
      }
    }
  }

  const ignoredTop = new Set(['node_modules', '.git', '.o4c', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv']);
  let topDirs: string[] = [];
  try {
    topDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !ignoredTop.has(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, 15);
  } catch {
    // unreadable root: no layout
  }
  const existing = instructionFileIn(root);
  const existingInstructions = existing && !/o4c\.md$/i.test(existing) ? existing.split(/[\\/]/).pop() : undefined;
  return { languages, commands, topDirs, ...(existingInstructions ? { existingInstructions } : {}) };
}

/** The draft O4C.md - short on purpose: a model reads all of it on every request. */
export function draftO4cMd(scan: ProjectScan): string {
  const lines = ['# Notes for o4c', ''];
  if (scan.existingInstructions) lines.push(`@${scan.existingInstructions}`, '');
  if (scan.languages.length) lines.push(`Languages: ${scan.languages.map((l) => `${l.id} (${l.files} files)`).join(', ')}.`, '');
  if (scan.commands.length) {
    lines.push('## Commands', '');
    for (const c of scan.commands) lines.push(`- ${c.what}: \`${c.command}\``);
    lines.push('', 'Run the tests after a change, and say if they could not be run.', '');
  }
  if (scan.topDirs.length) {
    lines.push('## Layout', '');
    for (const d of scan.topDirs) lines.push(`- ${d}/`);
    lines.push('');
  }
  lines.push('## Conventions', '', '- (Add your own: style, naming, what must not be changed.)', '');
  return lines.join('\n');
}
