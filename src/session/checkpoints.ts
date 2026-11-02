import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CoreComponent } from '../agent/coreSeam.js';
import { CONTINUATION_TAG } from '../agent/contextEntry.js';

/**
 * Checkpoints (plan 0006 C1): the project's files as they were before each turn changed anything,
 * kept in a **shadow** git repository under `.o4c/checkpoints/` - never the user's own `.git`,
 * whose history, index and branches are theirs. The shadow repository uses the project directory as
 * its work tree, so it sees the same files (and honours the same `.gitignore`), and excludes `.o4c/`
 * and `.git/` itself.
 *
 * One snapshot per turn, taken at the turn's first mutating tool call: that commit is the state to
 * go back to. `/undo` restores the newest one, `/rewind` any one, `/diff` compares against one.
 * Before restoring, the current state is snapshotted too, so an undo can itself be undone.
 *
 * Needs a `git` executable. Without one, checkpoints are simply unavailable and say so.
 */

export const CHECKPOINTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  -- The id of the user message that started the turn, so a conversation rewind knows where to cut.
  turn_entry_id TEXT,
  label TEXT NOT NULL,
  git_commit TEXT NOT NULL,
  -- 'turn' (before a turn's changes) or 'restore' (before an undo/rewind replaced the files).
  kind TEXT NOT NULL DEFAULT 'turn',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, id);
`;

export interface CheckpointRow {
  id: number;
  session_id: string;
  turn_entry_id: string | null;
  label: string;
  git_commit: string;
  kind: 'turn' | 'restore';
  created_at: number;
}

export class CheckpointStore {
  constructor(private readonly db: DatabaseSync) {}

  add(row: Omit<CheckpointRow, 'id' | 'created_at'>): CheckpointRow {
    const created = Date.now();
    const result = this.db
      .prepare(`INSERT INTO checkpoints (session_id, turn_entry_id, label, git_commit, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.session_id, row.turn_entry_id, row.label, row.git_commit, row.kind, created);
    return { ...row, id: Number(result.lastInsertRowid), created_at: created };
  }

  /** Newest first. */
  list(sessionId: string, kind: CheckpointRow['kind'] | undefined = 'turn'): CheckpointRow[] {
    const rows = kind
      ? this.db.prepare(`SELECT * FROM checkpoints WHERE session_id = ? AND kind = ? ORDER BY id DESC`).all(sessionId, kind)
      : this.db.prepare(`SELECT * FROM checkpoints WHERE session_id = ? ORDER BY id DESC`).all(sessionId);
    return rows as unknown as CheckpointRow[];
  }
}

/** The shadow repository and the git operations on it. */
export class ShadowGit {
  readonly gitDir: string;

  constructor(readonly projectRoot: string) {
    this.gitDir = join(projectRoot, '.o4c', 'checkpoints');
  }

  private git(args: string[], input?: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('git', [`--git-dir=${this.gitDir}`, `--work-tree=${this.projectRoot}`, ...args], {
      cwd: this.projectRoot,
      encoding: 'utf-8',
      input,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'o4c', GIT_AUTHOR_EMAIL: 'o4c@localhost', GIT_COMMITTER_NAME: 'o4c', GIT_COMMITTER_EMAIL: 'o4c@localhost' },
    });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error ? String(r.error.message) : '') };
  }

  /** Whether git is installed. Checked once per process. */
  static available(): boolean {
    ShadowGit.gitFound ??= spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
    return ShadowGit.gitFound;
  }
  private static gitFound: boolean | undefined;

  private ensureRepo(): void {
    if (existsSync(join(this.gitDir, 'HEAD'))) return;
    mkdirSync(this.gitDir, { recursive: true });
    const init = this.git(['init', '--quiet']);
    if (!init.ok) throw new Error(`could not create the checkpoint repository: ${init.err}`);
    // Its own files and the user's repository are never part of a snapshot.
    mkdirSync(join(this.gitDir, 'info'), { recursive: true });
    writeFileSync(join(this.gitDir, 'info', 'exclude'), '.o4c/\n.git/\n');
    this.git(['config', 'core.autocrlf', 'false']);
    this.git(['config', 'core.safecrlf', 'false']);
  }

  /** Commits the work tree as it is now; returns the commit id. */
  snapshot(label: string): string {
    this.ensureRepo();
    const add = this.git(['add', '-A', '--', '.']);
    if (!add.ok) throw new Error(`snapshot failed: ${add.err}`);
    const commit = this.git(['commit', '--quiet', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)]);
    if (!commit.ok) throw new Error(`snapshot failed: ${commit.err}`);
    return this.git(['rev-parse', 'HEAD']).out;
  }

  /** Files that differ between a commit and the work tree now (snapshotting it first). */
  changedSince(commit: string): { current: string; files: string[] } {
    const current = this.snapshot(`state before restoring ${commit.slice(0, 8)}`);
    const diff = this.git(['diff', '--name-status', '--no-renames', commit, current]);
    return { current, files: diff.out ? diff.out.split('\n') : [] };
  }

  /**
   * Puts the work tree back as it was at `commit`: modified and deleted files restored, files
   * created since removed. Only files the shadow repository tracks are touched.
   */
  restore(commit: string): { current: string; restored: number; removed: number } {
    const { current, files } = this.changedSince(commit);
    let removed = 0;
    let restored = 0;
    for (const line of files) {
      const [status, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (status === 'A') {
        rmSync(join(this.projectRoot, path), { force: true });
        removed++;
      } else {
        restored++;
      }
    }
    if (restored > 0) {
      const checkout = this.git(['checkout', commit, '--', '.']);
      if (!checkout.ok) throw new Error(`restore failed: ${checkout.err}`);
    }
    return { current, restored, removed };
  }

  /** `git diff --stat` plus the patch, from `commit` to now. */
  diffSince(commit: string, maxChars = 20_000): string {
    const now = this.snapshot(`state for diff against ${commit.slice(0, 8)}`);
    const stat = this.git(['diff', '--stat', commit, now]).out;
    if (!stat) return 'No changes.';
    const patch = this.git(['diff', commit, now]).out;
    const body = patch.length > maxChars ? `${patch.slice(0, maxChars)}\n... (${(patch.length - maxChars).toLocaleString()} more characters)` : patch;
    return `${stat}\n\n${body}`;
  }
}

/** What the TUI needs for /undo, /rewind and /diff. */
export interface CheckpointHooks {
  shadow: ShadowGit;
  store: CheckpointStore;
  sessionId: string;
}

/**
 * Takes the turn's checkpoint just before its first mutating tool call (C1) - a turn that only
 * reads costs nothing. Also remembers the turn's user message, so a conversation rewind knows
 * where the turn began.
 */
export function checkpointComponent(hooks: CheckpointHooks, warn?: (text: string) => void): CoreComponent {
  let taken = false;
  let turnEntryId: string | null = null;
  let turnLabel = '';
  return {
    name: 'checkpoints',
    onEntry(entry) {
      if (entry.type === 'user' && entry.sub_type === 'input' && !(entry.tags ?? []).includes(CONTINUATION_TAG)) {
        turnEntryId = entry.id;
        turnLabel = entry.content.split('\n')[0]!.slice(0, 80);
        taken = false;
      }
    },
    async aroundTool({ tool }, next) {
      if (tool.mutating && !taken) {
        taken = true;
        try {
          const commit = hooks.shadow.snapshot(`before: ${turnLabel}`);
          hooks.store.add({ session_id: hooks.sessionId, turn_entry_id: turnEntryId, label: turnLabel || '(turn)', git_commit: commit, kind: 'turn' });
        } catch (err) {
          // A failed snapshot costs the undo for this turn, never the tool call itself.
          warn?.(`Checkpoint not taken: ${(err as Error).message}`);
        }
      }
      return next();
    },
  };
}
