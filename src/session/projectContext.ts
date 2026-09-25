import { readFile, mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { defaultSessionsDir } from './sessionStore.js';
import { defaultLogsDir } from './runLog.js';
import { seedLocalConfig } from './configStore.js';
import { loadProfile, recordAppliedProfile } from './profiles.js';

export function defaultGlobalDir(): string {
  return join(homedir(), '.o4c');
}

/** Where this run's sessions should live: the trusted project's own pool, or the global fallback. */
export function sessionsDirFor(projectRoot: string | undefined): string {
  return projectRoot ? join(projectRoot, '.o4c', 'sessions') : defaultSessionsDir();
}

/** Where this run's logs should live: the trusted project's own stream, or the global fallback. */
export function logsDirFor(projectRoot: string | undefined): string {
  return projectRoot ? join(projectRoot, '.o4c', 'logs') : defaultLogsDir();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Walks upward from `cwd` looking for a `.o4c` directory - the same "nearest ancestor" search
 * `git` does for `.git`, so running from inside a subpackage still finds the right project root.
 * Returns undefined if no trusted project exists anywhere above `cwd`.
 *
 * The walk stops at (and never matches) the user's home directory itself - `~/.o4c` is the
 * *global* config dir, not a project root, and without this exclusion every temp-directory-based
 * test (and any real project living under the home dir generally) would spuriously "find" it as
 * an ancestor the moment the global dir actually exists on a real machine.
 */
export async function findProjectRoot(cwd: string): Promise<string | undefined> {
  const home = resolve(homedir());
  let dir = resolve(cwd);
  for (;;) {
    if (dir === home) return undefined;
    if (await directoryExists(join(dir, '.o4c'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface TrustResult {
  trusted: boolean;
  /** Only set when trusted - the directory that owns `.o4c/` (an existing one, or `cwd` if just created). */
  projectRoot: string | undefined;
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The trust gate: if `cwd` (or an ancestor) already has `.o4c/`, it's trusted - no prompt, ever
 * again, since the directory's existence is itself the trust record. Otherwise asks once. A "no"
 * answer, or no TTY to ask on (piped/non-interactive), leaves `.o4c/` uncreated: this run
 * proceeds untrusted (global-only), and the question is simply asked again next run.
 *
 * Don't read any project-level `o4c.md`/`config.json` before this resolves - an untrusted
 * directory's content is attacker-controlled text from whoever's repo this is, and folding it
 * into the system prompt unconditionally would be a real prompt-injection surface.
 */
export async function ensureTrusted(
  cwd: string,
  prompt: (question: string) => Promise<string> = defaultPrompt,
  configGlobalDir?: string,
  profileName?: string,
): Promise<TrustResult> {
  const existingRoot = await findProjectRoot(cwd);
  if (existingRoot) return { trusted: true, projectRoot: existingRoot };

  if (!process.stdin.isTTY) return { trusted: false, projectRoot: undefined };

  const answer = await prompt(
    `This project hasn't been used with o4c before: ${cwd}\nDo you trust this project? (y/N) `,
  );
  if (!/^y(es)?$/i.test(answer.trim())) return { trusted: false, projectRoot: undefined };

  // Resolved before creating .o4c/ - if profileName is given but doesn't exist, fail loudly
  // rather than silently trusting the project with a typo'd/missing profile silently ignored.
  let profileBundle: Record<string, unknown> | undefined;
  if (profileName) {
    profileBundle = await loadProfile(profileName, configGlobalDir);
    if (!profileBundle) {
      throw new Error(
        `No such profile: "${profileName}" (looked for {globalDir}/profiles/${profileName}.json).`,
      );
    }
  }

  await mkdir(join(cwd, '.o4c'), { recursive: true });
  // Copy-on-trust seeding: the new local config.json starts as a copy of the current global one
  // (deep-merged with profileBundle on top, if a profile was selected), so /set-*/config-*
  // local and global start identical (or global-plus-profile) for this project. configGlobalDir
  // is test-only (defaults to the real ~/.o4c otherwise) - same purpose as resolveO4cMd's own
  // optional globalDir parameter below.
  await seedLocalConfig(cwd, configGlobalDir, profileBundle);
  if (profileName) {
    await recordAppliedProfile(cwd, profileName);
  }
  return { trusted: true, projectRoot: cwd };
}

/** Every directory from `root` down to `cwd` inclusive (both equal when cwd === root). */
function dirsFromRootToCwd(root: string, cwd: string): string[] {
  const rel = relative(root, cwd);
  const dirs = [root];
  if (rel && rel !== '.' && !rel.startsWith('..')) {
    let current = root;
    for (const segment of rel.split(sep)) {
      current = join(current, segment);
      dirs.push(current);
    }
  }
  return dirs;
}

/**
 * Collects the `o4c.md` cascade - global, then project root, then any subproject directory down
 * to `cwd` - and concatenates whichever levels actually have one, broadest first. Callers fold
 * the result into the system prompt; there's no structured "override" here (this is prose, not
 * key/value config), so the instruction to the model is simply that later sections take
 * precedence over earlier ones if they conflict.
 */
export async function resolveO4cMd(
  cwd: string,
  projectRoot: string | undefined,
  globalDir: string = defaultGlobalDir(),
): Promise<string> {
  const sections: Array<{ path: string; content: string }> = [];

  const globalPath = join(globalDir, 'o4c.md');
  const globalContent = await readIfExists(globalPath);
  if (globalContent?.trim()) sections.push({ path: globalPath, content: globalContent });

  if (projectRoot) {
    for (const dir of dirsFromRootToCwd(projectRoot, cwd)) {
      const path = join(dir, 'o4c.md');
      const content = await readIfExists(path);
      if (content?.trim()) sections.push({ path, content });
    }
  }

  if (sections.length === 0) return '';

  const body = sections.map((s) => `--- o4c.md (${s.path}) ---\n${s.content.trim()}`).join('\n\n');
  return [
    'Project context (o4c.md), broadest first - later, more specific sections take precedence',
    'if they conflict with earlier ones:',
    '',
    body,
  ].join('\n');
}
