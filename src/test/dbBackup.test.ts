import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyPendingRestore, backupDatabases, checkBackup, dbDirsFor, listBackups, scheduleRestore } from '../session/dbBackup.js';

function makeDb(path: string, value: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (v TEXT); DELETE FROM t;');
  db.prepare('INSERT INTO t (v) VALUES (?)').run(value);
  db.close();
}

function readDb(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('SELECT v FROM t').get() as { v: string }).v;
  } finally {
    db.close();
  }
}

function setup(): { root: string; home: string; dirs: ReturnType<typeof dbDirsFor> } {
  const root = mkdtempSync(join(tmpdir(), 'o4c-backup-'));
  const home = join(root, 'home');
  const project = join(root, 'proj');
  const dirs = dbDirsFor(project, home);
  mkdirSync(dirs.project!, { recursive: true });
  mkdirSync(dirs.global, { recursive: true });
  return { root, home, dirs };
}

test('backup snapshots project and global databases, even one held open mid-WAL', () => {
  const { root, dirs } = setup();
  try {
    makeDb(join(dirs.project!, 'history.db'), 'v1');
    makeDb(join(dirs.global, 'global.db'), 'g1');
    const live = new DatabaseSync(join(dirs.project!, 'history.db'));
    live.exec("INSERT INTO t (v) VALUES ('uncheckpointed')");
    const b = backupDatabases(dirs, new Date('2026-11-02T10:00:00.000Z'));
    live.close();
    assert.equal(b.stamp, '2026-11-02T10-00-00-000Z');
    assert.deepEqual(b.files.map((f) => f.name), ['project/history.db', 'global/global.db']);
    const db = new DatabaseSync(join(b.dir, 'project', 'history.db'), { readOnly: true });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n, 2, 'the WAL write is in the snapshot');
    db.close();
    assert.deepEqual(listBackups(dirs).map((x) => x.stamp), ['2026-11-02T10-00-00-000Z']);
    assert.deepEqual(checkBackup(dirs, b.stamp), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scheduled restore is applied at startup, and what it replaced is kept', () => {
  const { root, dirs } = setup();
  try {
    makeDb(join(dirs.project!, 'history.db'), 'old');
    const b = backupDatabases(dirs, new Date('2026-11-02T10:00:00.000Z'));
    makeDb(join(dirs.project!, 'history.db'), 'new');
    assert.equal(applyPendingRestore(dirs), undefined, 'nothing pending');
    scheduleRestore(dirs, b.stamp);
    const note = applyPendingRestore(dirs, new Date('2026-11-02T11:00:00.000Z'))!;
    assert.match(note, /Restored project\/history\.db from the 2026-11-02T10-00-00-000Z backup/);
    assert.equal(readDb(join(dirs.project!, 'history.db')), 'old');
    assert.equal(readDb(join(dirs.backups, '2026-11-02T11-00-00-000Z-before-restore', 'project', 'history.db')), 'new');
    assert.equal(applyPendingRestore(dirs), undefined, 'the marker is gone');
    assert.deepEqual(listBackups(dirs).map((x) => x.stamp), ['2026-11-02T10-00-00-000Z'], 'before-restore folders are not offered as backups');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt backup is refused and the live database is left alone', () => {
  const { root, dirs } = setup();
  try {
    makeDb(join(dirs.project!, 'history.db'), 'live');
    const bad = join(dirs.backups, '2026-11-02T09-00-00-000Z', 'project');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'history.db'), 'this is not a database');
    assert.equal(checkBackup(dirs, '2026-11-02T09-00-00-000Z').length, 1);
    scheduleRestore(dirs, '2026-11-02T09-00-00-000Z');
    assert.match(applyPendingRestore(dirs)!, /NOT done/);
    assert.equal(readDb(join(dirs.project!, 'history.db')), 'live');
    assert.equal(existsSync(join(dirs.backups, 'restore-pending.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a project only the global databases are covered, backed up under the home folder', () => {
  const dirs = dbDirsFor(undefined, '/h');
  assert.equal(dirs.project, undefined);
  assert.equal(dirs.backups, join('/h', '.o4c', 'backups'));
});
