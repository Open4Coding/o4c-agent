import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { deepMerge } from './jsonMerge.js';
import { findSolutionDir } from './solution.js';

/** `solution` (plan 0006 E21) sits between global and local - see solution.ts. */
export type ConfigScope = 'local' | 'global' | 'personal' | 'solution';

/** `~/.o4c` - deliberately a standalone copy of this one-line computation rather than importing
 * it from `projectContext.ts` (which already has its own `defaultGlobalDir()`): that module
 * would need to import back into this one for the copy-on-trust seeding call in `ensureTrusted()`
 * below, and a two-file cycle isn't worth avoiding one duplicated `join()` call - the rest of
 * `session/` already tolerates this (`sessionStore.ts`'s own `defaultSessionsDir()` doesn't reuse
 * `projectContext.ts`'s version either). */
export function defaultGlobalConfigDir(): string {
  return join(homedir(), '.o4c');
}

/** `personal` writes `config.local.json` (always gitignored, highest precedence - a teammate's
 * `git pull` bringing in a shared `config.json` change can never touch this file); `local` and
 * `global` both write plain `config.json`. See o4c-agent-design.md §1.5/§5. */
function configFileName(scope: ConfigScope): string {
  return scope === 'personal' ? 'config.local.json' : 'config.json';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Writes a config file so a reader never sees it half-written: the whole text to a temp file
 * beside it, then a rename over the old one. Found 2026-11-03 by CI's install smoke test: the
 * startup tip counter's fire-and-forget `set()` truncated `~/.o4c/config.json` while the one-shot
 * path was reading it, `JSON.parse('')` threw, and the run ended with no output at all - about
 * five launches in six on Linux. On Windows a rename can briefly fail while another handle has the
 * file open, so it is retried, and as a last resort the file is written in place as before.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text, 'utf-8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      await rm(tmp, { force: true });
      await writeFile(path, text, 'utf-8');
      return;
    }
  }
}

/**
 * The local/global/personal config store behind every `/set-*` and `/config-*` command. Three
 * `config.json`-family files per project - **global** (`~/.o4c`), **local** (`.o4c` inside the
 * trusted project root, shared/potentially committed), and **personal** (`.o4c/config.local.json`
 * in the same project, always gitignored, highest precedence) - resolved global -> local ->
 * personal, personal winning on any conflict.
 *
 * An optional `namespace` (e.g. `['plugins', 'some-plugin-id']`) scopes an instance to a
 * subdirectory under each tier's own dir, so the exact same class serves both core config
 * (`.o4c/config.json`) and per-plugin config (`.o4c/plugins/<id>/config.json`) without a second,
 * parallel implementation of the tiering/merge logic.
 */
export class ConfigStore {
  /** The solution folder above the project (E21), found once; `null` passed in means none. */
  private readonly solutionDir: string | undefined;

  constructor(
    private projectRoot: string | undefined,
    private globalDir: string = defaultGlobalConfigDir(),
    private namespace: string[] = [],
    solutionDir?: string | null,
  ) {
    this.solutionDir = solutionDir === null ? undefined : (solutionDir ?? findSolutionDir(projectRoot));
  }

  /** Base directory for a scope, before applying `namespace` - `global` is always the machine's
   * global dir; `local` and `personal` share the same project-local `.o4c` dir (they only differ
   * by filename, via `configFileName`), and are `undefined` together when there's no trusted
   * project - neither ever falls back to global silently, since that would make `/set-local-X`/
   * `/set-personal-X`/bare `/set-X` (which also means local) quietly become global on an
   * untrusted project, the opposite of what they say. */
  private baseDirFor(scope: ConfigScope): string | undefined {
    if (scope === 'global') return this.globalDir;
    if (scope === 'solution') return this.solutionDir;
    return this.projectRoot ? join(this.projectRoot, '.o4c') : undefined;
  }

  private dirFor(scope: ConfigScope): string | undefined {
    const base = this.baseDirFor(scope);
    if (!base) return undefined;
    return this.namespace.length ? join(base, ...this.namespace) : base;
  }

  /** Where a scope's config file is (or would be) - /doctor and /edit-config (plan 0006 E3). */
  configPath(scope: ConfigScope): string | undefined {
    return this.pathFor(scope);
  }

  private pathFor(scope: ConfigScope): string | undefined {
    const dir = this.dirFor(scope);
    return dir ? join(dir, configFileName(scope)) : undefined;
  }

  /** Raw contents of exactly one scope's own config file - no merging with the other scopes.
   * `{}` both when the file doesn't exist yet and when local/personal have no trusted project -
   * a caller that needs to tell those apart should check `hasScope()` first. */
  async readScope(scope: ConfigScope): Promise<Record<string, unknown>> {
    const path = this.pathFor(scope);
    if (!path) return {};
    return readJsonIfExists(path);
  }

  /** Whether this scope is actually writable right now - `false` for `local`/`personal` with no
   * trusted project, always `true` for `global`. */
  hasScope(scope: ConfigScope): boolean {
    return this.dirFor(scope) !== undefined;
  }

  /** The effective, merged view - global -> local -> personal, each later tier overriding the
   * previous key-by-key. What a feature should read when it just wants "the current value," not
   * caring which scope it came from. */
  async resolve(): Promise<Record<string, unknown>> {
    const [global, solution, local, personal] = await Promise.all([
      this.readScope('global'),
      this.readScope('solution'),
      this.readScope('local'),
      this.readScope('personal'),
    ]);
    return deepMerge(deepMerge(deepMerge(global, solution), local), personal);
  }

  /** A single key from the effective (merged) view. */
  async get(key: string): Promise<unknown> {
    return (await this.resolve())[key];
  }

  /** Sets one key in exactly the given scope's own config file, merged with whatever else is
   * already in that specific file - `/set-global-X` must only ever touch the global file's own
   * content, never the locally-resolved view. Throws for `local`/`personal` with no trusted
   * project (nothing to write into); callers should check `hasScope()` first to give a clearer
   * user-facing message than a raw thrown error. */
  async set(scope: ConfigScope, key: string, value: unknown): Promise<void> {
    const dir = this.dirFor(scope);
    const path = this.pathFor(scope);
    if (!dir || !path) {
      throw new Error(
        'No trusted project in this directory - nothing to set a local value into. Trust this project first, or use the -global- form instead.',
      );
    }
    const current = await readJsonIfExists(path);
    current[key] = value;
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(path, current);
  }
}

/**
 * Which scope a write to `config[key][entry]` must land in for the merged view to actually return
 * it - the highest-precedence scope that already has an entry under that name, or `fallback` when
 * none does.
 *
 * Needed because writing and reading are not symmetric here: `resolve()` layers global -> local ->
 * personal, and `copyGlobalConfigToProject()` below seeds a newly trusted project's local
 * `config.json` as a snapshot of global. A feature that reads with `get()` but always writes
 * `global` therefore works until the first project is trusted, and from then on writes into a file
 * the snapshot permanently shadows. `/think` had exactly that bug (reported 2026-10-09: the level
 * reverted to the snapshot's value at every end-of-turn reload), which is what this exists to stop.
 *
 * Checks the entry rather than the key because `deepMerge` merges these maps entry-by-entry: a
 * local `thinkLevelByModel` holding some other model says nothing about where this model's level
 * should go.
 */
export async function scopeOwningEntry(
  store: ConfigStore,
  key: string,
  entry: string,
  fallback: ConfigScope = 'global',
): Promise<ConfigScope> {
  // Highest precedence first - personal wins over local, so it is also where an update must go.
  for (const scope of ['personal', 'local', 'solution'] as const) {
    if (!store.hasScope(scope)) continue;
    const own = (await store.readScope(scope))[key];
    if (own && typeof own === 'object' && (own as Record<string, unknown>)[entry] !== undefined) return scope;
  }
  return fallback;
}

/**
 * Copy-on-trust seeding: the moment a project is trusted for the first time (`ensureTrusted()`
 * in `projectContext.ts`), its new local `config.json` starts as a copy of the current global
 * one - optionally deep-merged with a chosen profile's own bundle on top (`profileBundle`,
 * loaded via `profiles.ts`), so a project seeded with e.g. a "data-analysis" profile starts from
 * global-defaults-plus-that-profile's-overrides, not just a plain global copy. After this, local
 * always overrides global where they differ, and further global-side (or profile-side) changes
 * never retroactively touch this already-seeded local copy - a one-time snapshot, not a live
 * link. This mirrors the profile-vs-project relationship too: editing a profile file later has
 * no effect on projects already seeded from it, for the same reason (see o4c-agent-design.md
 * §1.5/§5's "template, not live reference" note).
 *
 * A no-op if there's nothing to seed at all (no global `config.json` AND no `profileBundle`) or
 * the local one already exists (never overwrites an existing local file - this only ever runs
 * once, at the exact moment `.o4c/` is first created, but stays defensive about it regardless).
 */
export async function seedLocalConfig(
  projectRoot: string,
  globalDir: string = defaultGlobalConfigDir(),
  profileBundle?: Record<string, unknown>,
): Promise<void> {
  const localDir = join(projectRoot, '.o4c');
  const localPath = join(localDir, 'config.json');
  if (await fileExists(localPath)) return;

  const globalPath = join(globalDir, 'config.json');
  // Inside a solution (E21) the project is not seeded from global: a snapshot would shadow every
  // solution setting it happened to share a key with. It follows global and solution live instead.
  const globalExists = !findSolutionDir(projectRoot) && (await fileExists(globalPath));
  if (!globalExists && !profileBundle) return;

  let seedContent: Record<string, unknown> = globalExists
    ? (JSON.parse(await readFile(globalPath, 'utf-8')) as Record<string, unknown>)
    : {};
  if (profileBundle) {
    seedContent = deepMerge(seedContent, profileBundle);
  }

  await mkdir(localDir, { recursive: true });
  await writeFile(localPath, JSON.stringify(seedContent, null, 2), 'utf-8');
}
