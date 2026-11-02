import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfiniteContextStore } from '../session/infiniteContextStore.js';
import { checkpointComponent, ShadowGit } from '../session/checkpoints.js';
import { userInputEntry } from '../agent/contextEntry.js';
import { openReadOnly, recordRows } from '../ui/dbBrowser.js';
import type { Tool } from '../tools/types.js';

/** Plan 0006 C1: checkpoints in a shadow git repository; /undo restores exactly; the user's .git is untouched. */

const hasGit = ShadowGit.available();
const sha = (path: string) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent');
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf-8' }).stdout.trim();

test('a 3-file change is undone exactly, created files removed, and the user repository untouched', { skip: !hasGit }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-ckpt-'));
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  writeFileSync(join(root, 'b.txt'), 'bravo\r\nwith CRLF\r\n');
  writeFileSync(join(root, 'c.txt'), 'charlie\n');
  // The user's own repository, with a commit and an unstaged change of their own.
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x', 'add', 'a.txt'], { cwd: root });
  spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '--quiet', '-m', 'user commit'], { cwd: root });
  // o4c's own directory exists before any turn in a real project; create it before taking the "before" status.
  const store = new InfiniteContextStore(join(root, '.o4c', 'db', 'history.db'));
  const userHead = git(root, 'rev-parse', 'HEAD');
  const userStatus = git(root, 'status', '--porcelain');
  const before = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((f) => sha(join(root, f)));

  const hooks = { shadow: new ShadowGit(root), store: store.checkpoints(), sessionId: 's1' };
  const component = checkpointComponent(hooks);
  component.onEntry!(userInputEntry('rewrite the letters'));
  const tool: Tool = { name: 'write_file', description: '', inputSchema: {}, mutating: true, execute: async () => 'ok' };
  await component.aroundTool!({ tool, input: {} }, async () => {
    writeFileSync(join(root, 'a.txt'), 'ALPHA\n');
    rmSync(join(root, 'b.txt'));
    writeFileSync(join(root, 'c.txt'), 'CHARLIE\n');
    writeFileSync(join(root, 'd.txt'), 'new\n');
    return 'ok';
  });
  // A second mutating call in the same turn takes no second checkpoint.
  await component.aroundTool!({ tool, input: {} }, async () => 'ok');
  const turns = hooks.store.list('s1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.label, 'rewrite the letters');

  assert.match(hooks.shadow.diffSince(turns[0]!.git_commit), /a\.txt[\s\S]*b\.txt[\s\S]*c\.txt[\s\S]*d\.txt/);
  const r = hooks.shadow.restore(turns[0]!.git_commit);
  assert.deepEqual({ restored: r.restored, removed: r.removed }, { restored: 3, removed: 1 });
  assert.deepEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((f) => sha(join(root, f))), before, 'byte-identical, CRLF kept');

  assert.equal(git(root, 'rev-parse', 'HEAD'), userHead, "the user's HEAD did not move");
  assert.equal(git(root, 'status', '--porcelain'), userStatus, "the user's working-tree status is as it was");

  // The undone state is still reachable.
  hooks.store.add({ session_id: 's1', turn_entry_id: null, label: 'restore point', git_commit: r.current, kind: 'restore' });
  hooks.shadow.restore(r.current);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf-8'), 'ALPHA\n');
  assert.equal(existsSync(join(root, 'd.txt')), true);
  store.close();

  // Visible in /view-db like every other table.
  const db = openReadOnly(join(root, '.o4c', 'db'), 'history.db');
  assert.equal(recordRows(db, 'checkpoints').filter((row) => row.key !== '__schema').length, 2);
  db.close();
});
