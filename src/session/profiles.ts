import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultGlobalConfigDir } from './configStore.js';

/**
 * Named, selectable presets for project-*type* defaults (e.g. `data-analysis.json` vs.
 * `production.json`), living at `{globalDir}/profiles/<name>.json`. A profile is a plain
 * `config.json`-shaped bundle - deep-merged over the global config at trust time via
 * `seedLocalConfig`'s `profileBundle` parameter, never resolved live at runtime. See
 * o4c-agent-design.md §1.5/§5: this is deliberately a one-time template, not a 4th resolve-time
 * tier and not a live reference - editing a profile file later has zero effect on projects
 * already seeded from it, matching the same one-time-snapshot precedent `seedLocalConfig`
 * already established for the plain global-copy case.
 */

export interface AppliedProfile {
  name: string;
  /** ISO 8601 timestamp of when this project was seeded from this profile. */
  appliedAt: string;
}

/** Reads one named profile bundle. `undefined` if no such profile exists - callers should treat
 * that as a real error to surface (e.g. `ensureTrusted` throws with a clear message), not
 * silently fall through to an empty bundle, since a typo'd profile name should never look
 * indistinguishable from "no profile requested." */
export async function loadProfile(
  name: string,
  globalDir: string = defaultGlobalConfigDir(),
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(join(globalDir, 'profiles', `${name}.json`), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Every profile name available at the global level (file names under `profiles/`, minus the
 * `.json` extension), sorted alphabetically. Empty array if the directory doesn't exist yet -
 * "no profiles defined" is a fully valid, permanent state, not an error. */
export async function listProfiles(globalDir: string = defaultGlobalConfigDir()): Promise<string[]> {
  try {
    const entries = await readdir(join(globalDir, 'profiles'));
    return entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Bookkeeping only, written once at trust time when a profile was used - `.o4c/.profile.json`
 * records which profile seeded this project and when. Never read back into the resolved config
 * (it's metadata about provenance, not a config source) - its only purpose today is so a future
 * manual "reapply" command (explicitly deferred, not built in this pass - see
 * o4c-agent-design.md §1.5/§5) has something to work from without re-deriving anything. */
export async function recordAppliedProfile(projectRoot: string, name: string): Promise<void> {
  const record: AppliedProfile = { name, appliedAt: new Date().toISOString() };
  const dir = join(projectRoot, '.o4c');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.profile.json'), JSON.stringify(record, null, 2), 'utf-8');
}
