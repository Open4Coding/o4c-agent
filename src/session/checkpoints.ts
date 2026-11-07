import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 *
 * Every git call is asynchronous and they run one at a time. The first `git add -A` of a big tree
 * hashes every file (1m42s on the VS Code source, 2026-11-06), and as a `spawnSync` that froze the
 * whole TUI; now it only waits. `warm()` does that first pass in the background at session start,
 * so the first edit's snapshot finds the shadow index already filled and takes a second or two.
 */

/** How long a snapshot waits for another git's index lock before trying anyway. */
const LOCK_WAIT_MS = 180_000;
/** An index lock this old belongs to no running git. */
const STALE_LOCK_MS = 15 * 60_000;

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

  private git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    return new Promise((resolve) => {
      // `gc.auto=0`: a commit never packs inline. The first snapshot of the VS Code source left 25,000
      // loose objects, and the commit then sat in `gc --auto` for ~20 s (found 2026-11-07); `warm()`
      // runs that housekeeping instead, off the edit path.
      const child = spawn('git', [`--git-dir=${this.gitDir}`, `--work-tree=${this.projectRoot}`, '-c', 'gc.auto=0', ...args], {
        cwd: this.projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'o4c', GIT_AUTHOR_EMAIL: 'o4c@localhost', GIT_COMMITTER_NAME: 'o4c', GIT_COMMITTER_EMAIL: 'o4c@localhost' },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      let spawnError = '';
      child.on('error', (e) => (spawnError = e.message));
      child.on('close', (code) =>
        resolve({
          ok: code === 0,
          out: Buffer.concat(out).toString('utf-8').trim(),
          err: Buffer.concat(err).toString('utf-8').trim() || spawnError,
        }),
      );
    });
  }

  /**
   * Runs `work` after every earlier operation has finished: two `git add`s at once would fight
   * over the shadow index's lock, and the session-start warm-up can still be running when the
   * first edit asks for its snapshot.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private queue: Promise<void> = Promise.resolve();

  /** Whether git is installed. Checked once per process. */
  static available(): boolean {
    ShadowGit.gitFound ??= spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
    return ShadowGit.gitFound;
  }
  private static gitFound: boolean | undefined;

  private async ensureRepo(): Promise<void> {
    if (existsSync(join(this.gitDir, 'HEAD'))) return;
    mkdirSync(this.gitDir, { recursive: true });
    const init = await this.git(['init', '--quiet']);
    if (!init.ok) throw new Error(`could not create the checkpoint repository: ${init.err}`);
    // Its own files and the user's repository are never part of a snapshot.
    mkdirSync(join(this.gitDir, 'info'), { recursive: true });
    writeFileSync(join(this.gitDir, 'info', 'exclude'), '.o4c/\n.git/\n');
    await this.git(['config', 'core.autocrlf', 'false']);
    await this.git(['config', 'core.safecrlf', 'false']);
  }

  private async stage(): Promise<void> {
    await this.ensureRepo();
    // o4c reloads itself after every turn, and a warm-up git from the process before can still be
    // finishing its first pass, holding the index lock. Give it time to let go rather than fail.
    // A lock older than any first pass is left over from a git that was killed: remove it, or every
    // snapshot from now on would fail.
    const lock = join(this.gitDir, 'index.lock');
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
    } catch {
      // no lock
    }
    for (let waited = 0; existsSync(lock) && waited < LOCK_WAIT_MS; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const add = await this.git(['add', '-A', '--', '.']);
    if (!add.ok) throw new Error(`snapshot failed: ${add.err}`);
  }

  /**
   * The expensive first-time work, done at session start instead of inside the first edit. Measured
   * on the VS Code source: the first `add -A` 56 s, the first commit (every tree object) ~20 s, and
   * git's housekeeping after it ~20 s; afterwards an add is 0.3 s and a commit 0.8 s. So: stage,
   * make the repository's first commit if it has none (not a checkpoint - nothing records it), and
   * pack loose objects when git thinks it is time. A failure here is left for the real snapshot.
   */
  warm(): Promise<void> {
    return this.serial(async () => {
      await this.stage();
      if (!(await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).ok) {
        await this.git(['commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'o4c checkpoint base']);
      }
      await this.git(['-c', 'gc.auto=6700', 'gc', '--auto', '--quiet']);
    }).catch(() => undefined);
  }

  /** Commits the work tree as it is now; returns the commit id. */
  snapshot(label: string): Promise<string> {
    return this.serial(() => this.doSnapshot(label));
  }

  private async doSnapshot(label: string): Promise<string> {
    await this.stage();
    const commit = await this.git(['commit', '--quiet', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)]);
    if (!commit.ok) throw new Error(`snapshot failed: ${commit.err}`);
    return (await this.git(['rev-parse', 'HEAD'])).out;
  }

  /** Files that differ between a commit and the work tree now (snapshotting it first). */
  changedSince(commit: string): Promise<{ current: string; files: string[] }> {
    return this.serial(() => this.doChangedSince(commit));
  }

  private async doChangedSince(commit: string): Promise<{ current: string; files: string[] }> {
    const current = await this.doSnapshot(`state before restoring ${commit.slice(0, 8)}`);
    const diff = await this.git(['diff', '--name-status', '--no-renames', commit, current]);
    return { current, files: diff.out ? diff.out.split('\n') : [] };
  }

  /**
   * Puts the work tree back as it was at `commit`: modified and deleted files restored, files
   * created since removed. Only files the shadow repository tracks are touched.
   */
  restore(commit: string): Promise<{ current: string; restored: number; removed: number }> {
    return this.serial(() => this.doRestore(commit));
  }

  private async doRestore(commit: string): Promise<{ current: string; restored: number; removed: number }> {
    const { current, files } = await this.doChangedSince(commit);
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
      const checkout = await this.git(['checkout', commit, '--', '.']);
      if (!checkout.ok) throw new Error(`restore failed: ${checkout.err}`);
    }
    return { current, restored, removed };
  }

  /** `git diff --stat` plus the patch, from `commit` to now. */
  diffSince(commit: string, maxChars = 20_000): Promise<string> {
    return this.serial(() => this.doDiffSince(commit, maxChars));
  }

  private async doDiffSince(commit: string, maxChars: number): Promise<string> {
    const now = await this.doSnapshot(`state for diff against ${commit.slice(0, 8)}`);
    const stat = (await this.git(['diff', '--stat', commit, now])).out;
    if (!stat) return 'No changes.';
    const patch = (await this.git(['diff', commit, now])).out;
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
          const commit = await hooks.shadow.snapshot(`before: ${turnLabel}`);
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
