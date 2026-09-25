/** Shared by configStore.ts (config.json's 3-tier resolve) and profiles.ts (profile-bundle
 * seeding) - extracted 2026-09-24 to stop the same deep-merge implementation existing in two
 * places (it used to be duplicated in configStore.ts and projectContext.ts; the latter's copy
 * was removed along with resolveSettings/settings.json, which this codebase never actually used
 * in production - see o4c-agent-design.md §1.5/§5 for the full reasoning). */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shallow-copies `base`, then applies `override`'s own keys on top. Recurses only when both
 * sides are plain objects at that key; arrays and any type-mismatched values replace wholesale,
 * never merge/concatenate. */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    result[key] = isPlainObject(value) && isPlainObject(baseValue) ? deepMerge(baseValue, value) : value;
  }
  return result;
}
