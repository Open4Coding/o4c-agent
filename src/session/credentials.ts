import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ConfigStore } from './configStore.js';

/**
 * The `credentials` map (plan 0006 F2): o4c's API keys, by provider id, in one place -
 *
 *   "credentials": {
 *     "local": "the key",                    (a value)
 *     "anthropic": { "env": "MY_CLAUDE_KEY" },   (read from that environment variable)
 *     "work-box": { "file": "~/.keys/work" }     (the first line of that file)
 *   }
 *
 * Read only from the personal `config.local.json` (always gitignored) and the global
 * `~/.o4c/config.json` - never from a project's shared `config.json` or a solution's, which get
 * committed; a `credentials` key found there is ignored and reported. One rule for every provider:
 * the map first, then the older config key (`localApiKey`), then the environment variable
 * (O4C_LOCAL_API_KEY, ANTHROPIC_API_KEY). Every value is registered for redaction, so it never
 * reaches a log or a session file.
 */
export type CredentialValue = string | { env: string } | { file: string };

export function resolveCredential(value: unknown, env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf-8')): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.env === 'string') return env[v.env]?.trim() || undefined;
  if (typeof v.file === 'string') {
    try {
      return read(v.file.replace(/^~(?=$|[\\/])/, homedir())).split(/\r?\n/)[0]!.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface Credentials {
  values: Record<string, string>;
  /** Names that are listed but resolve to nothing, and credentials found in a shared file. */
  problems: string[];
}

export async function loadCredentials(store: ConfigStore, env: NodeJS.ProcessEnv = process.env, read?: (path: string) => string): Promise<Credentials> {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const scope of ['local', 'solution'] as const) {
    if (store.hasScope(scope) && (await store.readScope(scope)).credentials !== undefined) {
      problems.push(`"credentials" in the ${scope} config.json is ignored - that file is shared; put keys in config.local.json or ~/.o4c/config.json.`);
    }
  }
  for (const scope of ['global', 'personal'] as const) {
    if (!store.hasScope(scope)) continue;
    const map = (await store.readScope(scope)).credentials;
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      problems.push(`"credentials" in the ${scope} config must be an object of name -> key.`);
      continue;
    }
    for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
      const value = resolveCredential(raw, env, read);
      if (value) values[name] = value;
      else problems.push(`credential "${name}" (${scope}) resolves to nothing - check its env variable or file.`);
    }
  }
  return { values, problems };
}
