import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandSection, docFiles, formatSection, searchDocs, splitSections, useDocFiles } from '../session/helpDocs.js';

/** Plan 0006 E4: /help <question> answered from the shipped docs, locally. */

test('sections split at headings, not at # inside code fences', () => {
  const s = splitSections('x.md', '# Title\nintro\n```sh\n# a comment\n```\n## `/undo`\nputs files back\n');
  assert.deepEqual(s.map((x) => x.heading), ['Title', '`/undo`']);
  assert.match(s[0]!.body, /# a comment/);
});

test('questions find the right section; a command finds its own section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-help-'));
  writeFileSync(join(dir, 'a.md'), '# Checkpoints\n\n## `/undo`\nPuts the project files back as they were before the last turn.\n\n## Permissions\nAllow, ask and deny rules decide which tool calls need approval.\n');
  writeFileSync(join(dir, 'b.md'), '# Shell\nrun_shell uses cmd.exe on Windows; /set-shell picks another.\n');
  useDocFiles([join(dir, 'a.md'), join(dir, 'b.md')]);
  try {
    assert.equal(searchDocs('how do I undo the last change to my files?')[0]!.heading, '`/undo`');
    assert.equal(searchDocs('which shell on windows')[0]!.heading, 'Shell');
    assert.equal(searchDocs('approval rules deny')[0]!.heading, 'Permissions');
    assert.deepEqual(searchDocs('the a of'), []);
    assert.equal(commandSection('/undo')!.heading, '`/undo`');
    assert.equal(commandSection('/nonexistent'), undefined);
    assert.match(formatSection(searchDocs('undo')[0]!), /^── `\/undo` {2}\(.*a\.md\)\nPuts the project files back/);
  } finally {
    useDocFiles(undefined);
  }
});

test('the bundled docs are found and searchable', () => {
  assert.ok(docFiles().some((f) => f.endsWith('README.md')));
  assert.ok(searchDocs('mcp server').length > 0);
});
