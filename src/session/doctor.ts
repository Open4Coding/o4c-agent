import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * `/doctor` (plan 0006 E3): the things that make o4c fail in ways that are hard to read from the
 * symptom - an old Node, a config file that does not parse, a server that answers but cannot call
 * tools, a damaged database - each checked, and each failure with what to do about it.
 */
export type CheckState = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  fix?: string;
}

export function checkNode(version = process.versions.node): Check {
  const [major, minor] = version.split('.').map(Number);
  const ok = major! > 22 || (major === 22 && minor! >= 5);
  return ok
    ? { name: 'Node.js', state: 'ok', detail: `v${version}` }
    : { name: 'Node.js', state: 'fail', detail: `v${version} is too old (node:sqlite needs 22.5 or newer)`, fix: 'Install Node.js 22 LTS or newer from nodejs.org, then reinstall o4c.' };
}

export function checkConfigFiles(files: Array<{ scope: string; path: string }>): Check[] {
  const out: Check[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f.path, 'utf-8');
    } catch {
      continue;
    }
    try {
      JSON.parse(text);
      out.push({ name: `Config (${f.scope})`, state: 'ok', detail: f.path });
    } catch (err) {
      out.push({ name: `Config (${f.scope})`, state: 'fail', detail: `${f.path}: ${(err as Error).message}`, fix: 'Fix the JSON (a trailing comma or a missing quote is the usual cause) - /edit-config opens it - or delete the file to go back to defaults.' });
    }
  }
  return out;
}

export function checkDatabases(dirs: Array<{ label: string; dir: string }>): Check[] {
  const out: Check[] = [];
  for (const { label, dir } of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.db'));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const db = new DatabaseSync(join(dir, name), { readOnly: true });
        const result = (db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined)?.quick_check;
        db.close();
        out.push(result === 'ok'
          ? { name: `Database ${name} (${label})`, state: 'ok', detail: 'integrity ok' }
          : { name: `Database ${name} (${label})`, state: 'fail', detail: `integrity check: ${result}`, fix: '/database-restore an earlier backup, or move the file aside - o4c rebuilds datagraph.db by itself; history.db and global.db hold history and memories.' });
      } catch (err) {
        out.push({ name: `Database ${name} (${label})`, state: 'fail', detail: (err as Error).message, fix: 'Close other o4c windows on this project and try again; if it persists, move the file aside.' });
      }
    }
  }
  return out;
}

export function checkDisk(path: string, minFreeBytes = 1024 ** 3): Check {
  try {
    const s = statfsSync(path);
    const free = Number(s.bavail) * Number(s.bsize);
    const gb = (free / 1024 ** 3).toFixed(1);
    return free >= minFreeBytes
      ? { name: 'Disk', state: 'ok', detail: `${gb} GB free` }
      : { name: 'Disk', state: 'warn', detail: `only ${gb} GB free`, fix: 'Free some space: run logs and tool output under .o4c/ can be deleted safely.' };
  } catch {
    return { name: 'Disk', state: 'warn', detail: 'could not read free space' };
  }
}

export function checkGit(): Check {
  const r = spawnSync('git', ['--version'], { encoding: 'utf-8', windowsHide: true });
  return r.status === 0
    ? { name: 'git', state: 'ok', detail: r.stdout.trim() }
    : { name: 'git', state: 'warn', detail: 'not found', fix: 'Install git (git-scm.com) - checkpoints (/undo, /rewind) and co-change hints need it.' };
}

export function formatChecks(checks: readonly Check[]): string[] {
  const mark: Record<CheckState, string> = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  const lines = ['Doctor:'];
  for (const c of checks) {
    lines.push(`  ${mark[c.state]} ${c.name}: ${c.detail}`);
    if (c.fix && c.state !== 'ok') lines.push(`       fix: ${c.fix}`);
  }
  const bad = checks.filter((c) => c.state === 'fail').length;
  const warn = checks.filter((c) => c.state === 'warn').length;
  lines.push(bad || warn ? `${bad} failure(s), ${warn} warning(s).` : 'Everything checked out.');
  return lines;
}
