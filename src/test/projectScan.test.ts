import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftO4cMd, scanProject } from '../session/projectScan.js';

/** Plan 0006 D2: /init's draft comes from the project's own files. */

test('a node project: languages, its scripts with the right runner, layout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-scan-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;');
  writeFileSync(join(root, 'test', 'a.test.js'), '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc', lint: 'eslint .', postinstall: 'x' } }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeFileSync(join(root, 'AGENTS.md'), 'Be brief.');
  const scan = await scanProject(root);
  assert.deepEqual(scan.languages[0], { id: 'typescript', files: 2 });
  assert.deepEqual(scan.commands.map((c) => `${c.what}: ${c.command}`), ['Test: pnpm test', 'Build: pnpm build', 'Lint: pnpm lint']);
  assert.deepEqual(scan.topDirs, ['src', 'test']);
  const draft = draftO4cMd(scan);
  assert.match(draft, /^# Notes for o4c\n\n@AGENTS\.md\n\nLanguages: typescript \(2 files\)/);
  assert.match(draft, /## Commands\n\n- Test: `pnpm test`\n- Build: `pnpm build`\n- Lint: `pnpm lint`\n\nRun the tests after a change/);
  assert.match(draft, /## Layout\n\n- src\/\n- test\/\n/);
  assert.match(draft, /## Conventions/);
});

test('python, rust, go and Makefile projects get their usual commands; npm uses "npm run" except test/start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-scan-'));
  writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  writeFileSync(join(root, 'Cargo.toml'), '');
  writeFileSync(join(root, 'go.mod'), '');
  writeFileSync(join(root, 'Makefile'), 'lint:\n\techo\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest', typecheck: 'tsc' } }));
  const commands = (await scanProject(root)).commands.map((c) => c.command);
  assert.deepEqual(commands, ['npm test', 'npm run typecheck', 'python -m pytest', 'cargo build', 'cargo test', 'go build ./...', 'go test ./...', 'make lint']);
});
