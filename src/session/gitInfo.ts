import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The footer's second line: which branch, and where you are within the project.
 *
 * Reads `.git/HEAD` directly instead of spawning `git rev-parse --abbrev-ref HEAD`. Same answer,
 * for a fraction of the cost: one small file read against a child process per call, which matters
 * because the status line is re-rendered on a timer (`elapsedTickMs`) and a `git` spawn per repaint
 * would be a measurable tax on an idle screen for a string that changes maybe twice a day. Callers
 * still read it once on mount and refresh on turn completion, never per render - this being cheap is
 * not a licence to call it in a render path.
 *
 * Front-end checklist item #14 ("git branch in header"), which had been open since 2026-10-01.
 */

/** A worktree or submodule has `.git` as a FILE containing `gitdir: <path>` rather than a
 * directory - without following it, every worktree would silently show no branch. */
const GITDIR_PREFIX = 'gitdir:';

/** `ref: refs/heads/<name>` is the normal, on-a-branch form. Anything else in HEAD is a raw commit
 * id, i.e. a detached checkout. */
const REF_PREFIX = 'ref:';
const HEADS_PREFIX = 'refs/heads/';

/** How far up to look for a repository root before giving up. A generous bound rather than
 * unlimited: the loop must terminate even if `dirname()` somehow stops shortening the path. */
const MAX_PARENTS = 64;

/** Resolves the directory holding `HEAD`, following a `.git` file for worktrees and submodules.
 * `undefined` when `start` is not inside a repository at all - which is a normal answer, not an
 * error: the meta workspace (`D:\AngelCode`) is not a repo, and neither are the scratch dirs. */
async function findGitDir(start: string): Promise<string | undefined> {
  let dir = start;
  for (let i = 0; i < MAX_PARENTS; i++) {
    const candidate = join(dir, '.git');
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
      if (info.isFile()) {
        const text = await readFile(candidate, 'utf-8');
        const line = text.split('\n').find((l) => l.trim().startsWith(GITDIR_PREFIX));
        const target = line?.trim().slice(GITDIR_PREFIX.length).trim();
        if (!target) return undefined;
        // Relative in a worktree ("gitdir: ../.git/worktrees/x"), absolute in a submodule.
        return target.startsWith('/') || /^[A-Za-z]:/.test(target) ? target : join(dir, target);
      }
    } catch {
      // Not here (or unreadable) - keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * The current branch name, a short commit id when HEAD is detached, or `undefined` when this is not
 * a repository.
 *
 * Never throws and never rejects: this feeds one cosmetic line of a status bar, and an unreadable
 * `.git` (permissions, a half-written HEAD during a rebase, a directory that vanished) must degrade
 * to showing no branch rather than taking down a render or a turn.
 */
export async function readGitBranch(startDir: string | undefined): Promise<string | undefined> {
  if (!startDir) return undefined;
  try {
    const gitDir = await findGitDir(startDir);
    if (!gitDir) return undefined;
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf-8')).trim();
    if (head.startsWith(REF_PREFIX)) {
      const ref = head.slice(REF_PREFIX.length).trim();
      // Keep the tail only: `refs/heads/feature/x` is the branch `feature/x`.
      return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
    }
    // Detached HEAD - a bare commit id. Seven characters is git's own short form.
    return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

/** How long to wait for `git status` before giving up and showing no marker. A dirty flag is
 * cosmetic, so a slow or wedged git (a lock held by another process, a network filesystem) must
 * cost a bounded amount of time and then stop mattering. */
const STATUS_TIMEOUT_MS = 2000;

/** `git status --porcelain` prints one line per change, so a pathologically dirty tree could print
 * more than this - which is itself the answer (there was output, so it is dirty), handled below
 * rather than treated as a failure. */
const STATUS_MAX_BUFFER = 2 * 1024 * 1024;

/**
 * Whether the working tree has uncommitted changes: `true` dirty, `false` clean, `undefined` when
 * this is not a repository or git could not answer.
 *
 * This one DOES spawn a child process, unlike `readGitBranch` right above it, and the asymmetry is
 * the point: a branch name is a file read, but "is anything uncommitted" means consulting the index
 * against the working tree, which is git's job and cannot be faked from `.git` alone without
 * reimplementing it badly. So the cost is paid where `readGitBranch` refuses to pay it - which is
 * why callers must keep this on the same cadence as the branch (mount, then turn completion) and
 * nowhere near a render path. The `findGitDir` guard means a non-repository costs a `stat` walk and
 * no spawn at all, which matters because the meta workspace and the scratch directories are not
 * repositories.
 *
 * Untracked files count as dirty. They are uncommitted work by any reading, and `--porcelain`
 * already honours `.gitignore`, so build output and scratch directories do not pin the flag on.
 *
 * Never throws: every failure path returns `undefined`, i.e. show no marker, because a status bar
 * must not be able to take down a turn.
 */
export async function readGitDirty(startDir: string | undefined): Promise<boolean | undefined> {
  if (!startDir) return undefined;
  try {
    if (!(await findGitDir(startDir))) return undefined;
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: startDir,
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
      // Without this a console window flashes on Windows on every refresh - once per turn, which
      // would be impossible to miss.
      windowsHide: true,
    });
    return stdout.trim().length > 0;
  } catch (err) {
    // Overflowing the buffer is not a failure to answer: there was more than 2 MB of porcelain
    // output, so the tree is emphatically dirty. Anything else (git missing, a timeout, a lock)
    // genuinely means "do not know".
    const code = (err as { code?: unknown })?.code;
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
    return undefined;
  }
}

/** Stands in for the segments between the volume and the project, so the label can name the drive
 * without claiming the project sits at its root. A bare `D:/o4c-agent/src` would be a path that
 * does not exist; `D:/.../o4c-agent/src` is honestly incomplete. */
const ELLIPSIS = '\u2026';

/** `D:` is not an absolute path to node - it means "the current directory on D:" - so comparing it
 * against a real path needs the separator back on. `/`, `/mnt/data` and `//server/share` are
 * already absolute and pass through untouched. */
function mountAsPath(mount: string): string {
  return isAbsolute(mount) ? mount : `${mount}${sep}`;
}

/** Trailing separator off (`D:\` -> `D:`, `/mnt/data/` -> `/mnt/data`) and separators normalised,
 * but never down to the empty string: the POSIX root is `/` and must stay `/`. */
function displayMount(path: string): string {
  const slashes = path.split(/[\\/]/).join('/');
  const trimmed = slashes.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Which volume the project lives on: the drive letter on Windows (`D:`, or `//server/share` for a
 * UNC path), and the mount point the path actually sits under on POSIX (`/`, `/mnt/data`,
 * `/Volumes/work`).
 *
 * The drive letter is the whole point of asking on Windows, where two projects of the same name on
 * C: and D: are ordinary. POSIX has no drive letter, so the equivalent fact is the mount point,
 * found by walking up while the device id stays the same - the first ancestor on a different
 * device is across the boundary, so the one before it is the mount. That is the same test `df`
 * applies, and it does not need `/proc/mounts`, so it works on macOS and in a container too.
 *
 * I/O, so call it once (the mount of a given directory cannot change while o4c is running) and
 * never from a render path. Never throws: a label is cosmetic, and an unreadable parent degrades
 * to the filesystem root rather than taking down a render.
 */
export async function readMountPoint(dir: string | undefined): Promise<string | undefined> {
  if (!dir) return undefined;
  const root = parse(dir).root;
  if (!root) return undefined; // A relative path - nothing truthful to say about its volume.
  // On Windows the volume IS the answer, and `stat().dev` adds nothing: a junction or a mounted
  // folder still reports the drive it is reached through, which is what the user typed and reads.
  if (process.platform === 'win32') return displayMount(root);
  try {
    let current = dir;
    const { dev } = await stat(current);
    for (let i = 0; i < MAX_PARENTS; i++) {
      const parent = dirname(current);
      if (parent === current) break; // the root is its own parent
      const info = await stat(parent);
      if (info.dev !== dev) break; // crossed a mount boundary - `current` is the mount point
      current = parent;
    }
    return displayMount(current);
  } catch {
    return displayMount(root);
  }
}

/**
 * Where you are, "project wise": the volume, then the project folder's own name plus the path
 * within it, e.g. `D:/\u2026/o4c-agent/src/agent`. Deliberately not the full absolute path - the
 * useful facts are which volume, which project and whereabouts inside it, and a complete
 * `D:/Open4Coding/o4c-agent/src/agent` crowds a line that already carries a branch name. The
 * elided middle is what keeps the short form from reading as a real path that isn't there.
 *
 * `mount` comes from `readMountPoint()`; without it the label is just the project-relative part,
 * which is what a non-local or not-yet-probed root gets.
 *
 * Pure, and separators are normalised to `/` so the label reads the same on every platform (the
 * footer is a display string, not a path to be passed to anything).
 */
export function projectLabel(projectRoot: string | undefined, cwd: string, mount?: string): string {
  const root = projectRoot ?? cwd;
  const name = basename(root) || root;
  const within = projectRoot ? relative(projectRoot, cwd) : '';
  // Outside the project, or exactly at its root: the name alone is the whole answer. Three cases,
  // and the third is the one that actually bites on this machine - `relative()` cannot express a
  // path across Windows drives as `..`, so it hands back an absolute path instead, which would
  // otherwise render as the nonsense `o4c-agent/C:/tmp.tmp` (a project on D: run from C:\tmp.tmp is
  // the everyday setup here, not a hypothetical).
  const tail =
    !within || within.startsWith('..') || isAbsolute(within) ? name : `${name}/${within.split(sep).join('/')}`;
  if (!mount) return tail;
  // Only elide when something is genuinely being left out: a project directly on the volume
  // (`D:\myproj`, `/myproj`) must read `D:/myproj`, not `D:/.../myproj`. A mount that does not
  // contain this root at all (`..` or, across volumes, an absolute answer) elides nothing either,
  // rather than inventing a gap.
  const between = relative(mountAsPath(mount), dirname(root));
  const gap = between === '' || between.startsWith('..') || isAbsolute(between) ? '' : `${ELLIPSIS}/`;
  // `/` already ends in its separator; `D:` and `/mnt/data` need one adding.
  return `${mount === '/' ? '' : mount}/${gap}${tail}`;
}
