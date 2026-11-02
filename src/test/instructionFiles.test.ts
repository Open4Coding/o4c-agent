import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandImports, instructionFileIn, subdirInstructionsComponent } from '../session/instructionFiles.js';
import { resolveO4cMd } from '../session/projectContext.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 D1: AGENTS.md / CLAUDE.md when there is no O4C.md; @path imports; subdirectory files on first touch. */

function project(): { root: string; globalDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'o4c-instr-'));
  const globalDir = mkdtempSync(join(tmpdir(), 'o4c-instr-global-'));
  return { root, globalDir };
}

test('one file per directory: O4C.md, else AGENTS.md, else CLAUDE.md (any case)', () => {
  const { root } = project();
  assert.equal(instructionFileIn(root), undefined);
  writeFileSync(join(root, 'CLAUDE.md'), 'claude');
  assert.match(instructionFileIn(root)!, /CLAUDE\.md$/);
  writeFileSync(join(root, 'Agents.md'), 'agents');
  assert.match(instructionFileIn(root)!, /Agents\.md$/);
  writeFileSync(join(root, 'O4C.md'), 'o4c');
  assert.match(instructionFileIn(root)!, /O4C\.md$/);
});

test('the prompt section uses AGENTS.md when that is all a project has, and names it', async () => {
  const { root, globalDir } = project();
  writeFileSync(join(root, 'AGENTS.md'), 'Run tests with `pnpm test`.\n@docs/style.md\nMail me@example.com');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'style.md'), 'Two-space indentation.');
  const section = await resolveO4cMd(root, root, globalDir);
  assert.match(section, /--- AGENTS\.md \(.*AGENTS\.md\) ---\nRun tests with `pnpm test`\.\n--- imported docs\/style\.md ---\nTwo-space indentation\.\n--- end of docs\/style\.md ---\nMail me@example\.com/);
});

test('imports nest, a cycle is cut, and a missing file is left as written', () => {
  const { root } = project();
  writeFileSync(join(root, 'a.md'), 'A then @b.md');
  writeFileSync(join(root, 'b.md'), 'B then @a.md and @missing.md');
  const out = expandImports('start @a.md', root);
  // a.md is already being imported, so b.md's @a.md stays as written - each file once.
  assert.equal(out, 'start --- imported a.md ---\nA then --- imported b.md ---\nB then @a.md and @missing.md\n--- end of b.md ---\n--- end of a.md ---');
});

test('a subdirectory file is given with the first tool result there, once, and remembered across a reload', async () => {
  const { root } = project();
  mkdirSync(join(root, 'pkg', 'api'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'AGENTS.md'), 'In pkg/: use tabs.');
  writeFileSync(join(root, 'pkg', 'api', 'x.ts'), 'export {};');
  writeFileSync(join(root, 'top.ts'), 'export {};');
  const seenFile = join(root, '.o4c', 'instructions-seen', 's1.json');
  const tool: Tool = { name: 'read_file', description: '', inputSchema: {}, execute: async () => 'contents' };
  const component = subdirInstructionsComponent({ projectRoot: root, cwd: root, seenFile });
  const call = (c: typeof component, path: string) => c.aroundTool!({ tool, input: { path } }, async () => 'contents');
  assert.equal(await call(component, 'top.ts'), 'contents', 'nothing for the working directory itself');
  assert.match(await call(component, 'pkg/api/x.ts'), /^contents\n\n\[o4c\] Instructions for pkg\/ \(pkg\/AGENTS\.md\), shown the first time you work there.*\nIn pkg\/: use tabs\.$/s);
  assert.equal(await call(component, 'pkg/api/x.ts'), 'contents', 'once');
  const reloaded = subdirInstructionsComponent({ projectRoot: root, cwd: root, seenFile });
  assert.equal(await call(reloaded, 'pkg/api/x.ts'), 'contents', 'still once after a reload');
});
