import type { ConfigScope, ConfigStore } from './configStore.js';

/**
 * The step limit: how many model requests one turn may make before o4c stops and asks Continue /
 * Summarize / Stop (B18). Set with `/set-steplimit` (this project), `/set-local-steplimit` (the same)
 * and `/set-global-steplimit` (every project on this machine); `0` means no limit.
 *
 * Stored as `stepLimit`. Before 2026-11-25 the only way to change it was the undocumented config key
 * `maxIterations`, which is still read so a config that set it keeps working; within one scope
 * `stepLimit` wins, and the commands drop the old key from the scope they write.
 */
export const STEP_LIMIT_KEY = 'stepLimit';
export const LEGACY_STEP_LIMIT_KEY = 'maxIterations';
export const DEFAULT_STEP_LIMIT = 25;

/** Lowest to highest precedence, the order `ConfigStore.resolve()` layers them. */
const SCOPES: readonly ConfigScope[] = ['global', 'solution', 'local', 'personal'];

/** One scope's own value, or undefined when it sets none. */
export function stepLimitIn(config: Record<string, unknown>): number | undefined {
  for (const key of [STEP_LIMIT_KEY, LEGACY_STEP_LIMIT_KEY]) {
    const v = config[key];
    if (typeof v === 'number' && Number.isInteger(v)) return Math.max(0, v);
  }
  return undefined;
}

/** The value in force and the scope it comes from; undefined when none is set (the default applies). */
export async function resolveStepLimit(store: ConfigStore): Promise<{ value: number; scope: ConfigScope } | undefined> {
  let found: { value: number; scope: ConfigScope } | undefined;
  for (const scope of SCOPES) {
    const v = stepLimitIn(await store.readScope(scope));
    if (v !== undefined) found = { value: v, scope };
  }
  return found;
}

/** A typed value: a whole number 0 or more, or off / none / infinite / unlimited for 0. */
export function parseStepLimit(raw: string): number | undefined {
  const t = raw.trim().toLowerCase();
  if (['off', 'none', 'infinite', 'unlimited', 'no limit'].includes(t)) return 0;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function describeStepLimit(n: number): string {
  return n === 0 ? 'no limit' : `${n} steps`;
}

/** Writes the value into one scope and drops that scope's old `maxIterations`, so only one key is left. */
export async function saveStepLimit(store: ConfigStore, scope: ConfigScope, n: number): Promise<void> {
  await store.set(scope, STEP_LIMIT_KEY, n);
  if ((await store.readScope(scope))[LEGACY_STEP_LIMIT_KEY] !== undefined) await store.set(scope, LEGACY_STEP_LIMIT_KEY, undefined);
}
