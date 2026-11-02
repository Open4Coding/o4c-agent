import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { createRememberTool, memoriesNote, openGlobalMemories } from '../session/memories.js';
import { openReadOnly, recordRows } from '../ui/dbBrowser.js';

/** Plan 0006 D3: memories across sessions - project and global, a capped note, stale paths flagged. */

function stores() {
  const root = mkdtempSync(join(tmpdir(), 'o4c-mem-'));
  const history = new InfiniteContextStore(join(root, '.o4c', 'db', 'history.db'));
  const global = openGlobalMemories(join(root, 'home-o4c-db'));
  return { root, history, global, s: { project: history.memories(), global: global.store } };
}

test('remember saves to the right scope and kind; the note lists rules first and flags paths that are gone', async () => {
  const { root, history, global, s } = stores();
  writeFileSync(join(root, 'present.ts'), '');
  const remember = createRememberTool(s);
  assert.match(await remember.execute({ text: 'The config loader is in present.ts', kind: 'fact' }), /^Remembered \(#1, fact, project\)/);
  assert.match(await remember.execute({ text: 'Always use pnpm, never npm', kind: 'rule' }), /rule, project/);
  assert.match(await remember.execute({ text: 'Answer in British English', kind: 'rule', scope: 'global' }), /rule, global/);
  assert.match(await remember.execute({ text: 'Old helper lives in src/gone.ts', kind: 'lesson' }), /lesson/);
  assert.match(await remember.execute({ text: '' }), /needs "text"/);

  const note = memoriesNote(s, root)!;
  const lines = note.split('\n').slice(1);
  assert.equal(lines[0], '- [rule] Always use pnpm, never npm');
  assert.match(note, /- \[rule, global\] Answer in British English/);
  assert.match(note, /- \[fact\] The config loader is in present\.ts\n/, 'an existing file is not flagged');
  assert.match(note, /src\/gone\.ts \(note: src\/gone\.ts no longer exists - this may be stale\)/);
  history.close();
  global.close();
});

test('edit and delete; nothing to say when there are no memories; the note is capped', () => {
  const { history, global, s } = stores();
  assert.equal(memoriesNote(s), undefined);
  const row = s.project.add('first version', 'fact');
  assert.equal(s.project.update(row.id, 'second version'), true);
  assert.match(memoriesNote(s)!, /second version/);
  assert.equal(s.project.remove(row.id), true);
  assert.equal(memoriesNote(s), undefined);
  for (let i = 0; i < 60; i++) s.project.add(`memory number ${i} with some words to take up room in the note`, 'fact');
  const capped = memoriesNote(s)!;
  assert.ok(capped.length < 2700, `note is ${capped.length} chars`);
  assert.match(capped, /\(\d+ more not shown - \/memory lists them all\)$/);
  history.close();
  global.close();
});

test('both tables are readable in /view-db', () => {
  const { root, history, global, s } = stores();
  s.project.add('a project fact');
  s.global.add('a global rule', 'rule');
  history.close();
  global.close();
  const projectDb = openReadOnly(join(root, '.o4c', 'db'), 'history.db');
  assert.equal(recordRows(projectDb, 'memories').filter((r) => r.key !== '__schema').length, 1);
  projectDb.close();
  const globalDb = openReadOnly(join(root, 'home-o4c-db'), 'global.db');
  assert.equal(recordRows(globalDb, 'memories').filter((r) => r.key !== '__schema').length, 1);
  globalDb.close();
});
