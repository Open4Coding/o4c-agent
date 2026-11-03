import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * `/database-backup` and `/database-restore` (plan 0006 E20). history.db is irreplaceable, so it
 * gets a real backup: every `.db` in the project's `.o4c/db` and in `~/.o4c/db`, copied with
 * `VACUUM INTO` - a consistent snapshot even while o4c has the database open and mid-write, which a
 * plain file copy of a WAL database is not.
 *
 * A restore cannot swap a database this process has open. So `/database-restore` checks the backup
 * (`PRAGMA integrity_check`), records it as pending, and o4c restarts; `applyPendingRestore` runs at
 * startup before anything opens a database, moves the current files aside into
 * `<stamp>-before-restore` (a restore is itself undoable), and copies the backup in.
 */
export interface DbDirs {
  /** `<project>/.o4c/db`, or undefined outside a trusted project. */
  project?: string;
  global: string;
  /** Where backups live: `<project>/.o4c/backups`, or `~/.o4c/backups` outside a project. */
  backups: string;
}

export function dbDirsFor(projectRoot: string | undefined, home = homedir()): DbDirs {
  return {
    project: projectRoot ? join(projectRoot, '.o4c', 'db') : undefined,
    global: join(home, '.o4c', 'db'),
    backups: projectRoot ? join(projectRoot, '.o4c', 'backups') : join(home, '.o4c', 'backups'),
  };
}

const PENDING = 'restore-pending.json';

function dbFiles(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.db'));
  } catch {
    return [];
  }
}

function stampNow(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Snapshots every database into `<backups>/<stamp>/{project,global}/`. */
export function backupDatabases(dirs: DbDirs, now = new Date()): { stamp: string; dir: string; files: { name: string; bytes: number }[] } {
  const stamp = stampNow(now);
  const dir = join(dirs.backups, stamp);
  const files: { name: string; bytes: number }[] = [];
  for (const [scope, src] of [['project', dirs.project], ['global', dirs.global]] as const) {
    for (const name of dbFiles(src)) {
      const outDir = join(dir, scope);
      mkdirSync(outDir, { recursive: true });
      const dest = join(outDir, name);
      const db = new DatabaseSync(join(src!, name), { readOnly: true });
      try {
        db.exec(`VACUUM INTO ${sqlString(dest)}`);
      } finally {
        db.close();
      }
      files.push({ name: `${scope}/${name}`, bytes: statSync(dest).size });
    }
  }
  return { stamp, dir, files };
}

export interface BackupInfo {
  stamp: string;
  files: string[];
  bytes: number;
}

/** Backups, newest first (the folders written by `backupDatabases`, not the before-restore ones). */
export function listBackups(dirs: DbDirs): BackupInfo[] {
  let stamps: string[];
  try {
    stamps = readdirSync(dirs.backups).filter((n) => /^\d{4}-\d\d-\d\dT[\d-]+Z$/.test(n));
  } catch {
    return [];
  }
  return stamps
    .sort()
    .reverse()
    .map((stamp) => {
      const files: string[] = [];
      let bytes = 0;
      for (const scope of ['project', 'global']) {
        for (const name of dbFiles(join(dirs.backups, stamp, scope))) {
          files.push(`${scope}/${name}`);
          bytes += statSync(join(dirs.backups, stamp, scope, name)).size;
        }
      }
      return { stamp, files, bytes };
    })
    .filter((b) => b.files.length > 0);
}

/** `PRAGMA integrity_check` on every file of a backup; the problems, or an empty list. */
export function checkBackup(dirs: DbDirs, stamp: string): string[] {
  const problems: string[] = [];
  for (const scope of ['project', 'global']) {
    for (const name of dbFiles(join(dirs.backups, stamp, scope))) {
      try {
        const db = new DatabaseSync(join(dirs.backups, stamp, scope, name), { readOnly: true });
        try {
          const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
          if (r?.integrity_check !== 'ok') problems.push(`${scope}/${name}: ${r?.integrity_check ?? 'no answer'}`);
        } finally {
          db.close();
        }
      } catch (err) {
        problems.push(`${scope}/${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return problems;
}

export function scheduleRestore(dirs: DbDirs, stamp: string): void {
  mkdirSync(dirs.backups, { recursive: true });
  writeFileSync(join(dirs.backups, PENDING), JSON.stringify({ stamp }), 'utf-8');
}

/**
 * At startup, before any database is opened: carry out a scheduled restore. Returns a line for the
 * user, or undefined when nothing was pending.
 */
export function applyPendingRestore(dirs: DbDirs, now = new Date()): string | undefined {
  const marker = join(dirs.backups, PENDING);
  if (!existsSync(marker)) return undefined;
  let stamp: string;
  try {
    stamp = (JSON.parse(readFileSync(marker, 'utf-8')) as { stamp: string }).stamp;
  } finally {
    rmSync(marker, { force: true });
  }
  const problems = checkBackup(dirs, stamp);
  if (problems.length) return `Database restore of ${stamp} NOT done - the backup failed its check: ${problems.join('; ')}`;
  const aside = join(dirs.backups, `${stampNow(now)}-before-restore`);
  const moved: string[] = [];
  for (const [scope, live] of [['project', dirs.project], ['global', dirs.global]] as const) {
    const from = join(dirs.backups, stamp, scope);
    const names = dbFiles(from);
    if (!live || names.length === 0) continue;
    mkdirSync(join(aside, scope), { recursive: true });
    mkdirSync(live, { recursive: true });
    for (const name of names) {
      for (const suffix of ['', '-wal', '-shm']) {
        const cur = join(live, name + suffix);
        if (existsSync(cur)) renameSync(cur, join(aside, scope, name + suffix));
      }
      copyFileSync(join(from, name), join(live, name));
      moved.push(`${scope}/${name}`);
    }
  }
  return `Restored ${moved.join(', ')} from the ${stamp} backup. The databases it replaced are in ${aside}.`;
}
