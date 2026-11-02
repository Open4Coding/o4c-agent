import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destructiveReason, splitShellSegments } from '../tools/interactive.js';
import { evaluateRules, loadRules } from '../session/permissionRules.js';
import { clearO4cIgnore, isO4cIgnored, o4cIgnoreComponent, setO4cIgnore } from '../tools/o4cIgnore.js';
import { grepTool } from '../tools/grep.js';
import { globTool } from '../tools/glob.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 C5: destructive-command confirm, protected paths, .o4cignore - all off by default. */

const tool = (name: string): Tool => ({ name, description: '', inputSchema: {}, mutating: true, execute: async () => 'ran' });

test('destructive commands are recognised per segment; ordinary ones are not', () => {
  for (const cmd of ['rm -rf build', 'npm test && rm -r dist', 'rd /s /q out', 'del /s *.log', 'Remove-Item -Recurse x', 'git reset --hard HEAD~1', 'git clean -fd', 'git push --force origin main', 'git checkout .', 'git branch -D old', 'psql -c "DROP TABLE users"', 'npm unpublish x']) {
    assert.ok(destructiveReason(cmd), cmd);
  }
  for (const cmd of ['rm build/a.txt', 'git reset HEAD a.ts', 'git push origin main', 'del a.txt', 'git checkout -b new', 'npm test', 'echo drop it']) {
    assert.equal(destructiveReason(cmd), undefined, cmd);
  }
});

test('protected paths deny writes and edits; confirmDestructive is read from config; both off by default', async () => {
  const off = await loadRules(async () => ({}));
  assert.equal(off.confirmDestructive, undefined);
  assert.equal(off.deny.length, 0);
  const on = await loadRules(async (scope) => (scope === 'local' ? { protectedPaths: ['.env', 'secrets/**'], confirmDestructive: true } : {}));
  assert.equal(on.confirmDestructive, true);
  const decide = (name: string, path: string) => evaluateRules(on, tool(name), { path }, splitShellSegments)?.decision;
  assert.equal(decide('write_file', '.env'), 'deny');
  assert.equal(decide('edit_file', 'secrets/prod/key.pem'), 'deny');
  assert.equal(decide('read_file', '.env'), undefined, 'protection is against changes, not reads');
  assert.equal(decide('edit_file', 'src/app.ts'), undefined);
});

test('.o4cignore hides files from glob and grep and refuses the file tools; nothing when absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-ignore-'));
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'app.js'), 'const token = 1;\n');
  writeFileSync(join(root, 'private', 'notes.md'), 'token: hunter2\n');
  writeFileSync(join(root, 'creds.json'), '{"token": "x"}\n');
  setO4cIgnore(root, 'private/\ncreds.json\n');
  try {
    assert.equal(isO4cIgnored(join(root, 'creds.json')), true);
    assert.equal(isO4cIgnored(join(root, 'app.js')), false);
    const grep = await grepTool.execute({ pattern: 'token', path: root });
    assert.match(grep, /app\.js/);
    assert.doesNotMatch(grep, /notes\.md|creds\.json/);
    assert.doesNotMatch(await globTool.execute({ pattern: '**/*', path: root }), /notes\.md|creds\.json/);
    const component = o4cIgnoreComponent();
    const refused = await component.aroundTool!({ tool: tool('read_file'), input: { path: join(root, 'creds.json') } }, async () => 'contents');
    assert.match(refused, /excluded by the project's \.o4cignore, so o4c does not read it/);
    assert.equal(await component.aroundTool!({ tool: tool('read_file'), input: { path: join(root, 'app.js') } }, async () => 'contents'), 'contents');
  } finally {
    clearO4cIgnore();
  }
  assert.match(await grepTool.execute({ pattern: 'token', path: root }), /creds\.json/, 'without .o4cignore everything is visible again');
});
