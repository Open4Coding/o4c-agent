import { AgentLoop } from '../agent/loop.js';
import { createProvider } from '../providers/factory.js';
import type { ConfigStore } from './configStore.js';

/**
 * First-run setup and `/setup` (plan 0006 I2): find a model server, get its key if it wants one,
 * prove it works with one real tool call, and save the result to the global config.
 *
 * Detection asks `GET /v1/models` - the one endpoint llama.cpp, Ollama and LM Studio all answer - on
 * their usual ports, plus whatever URL is already configured. 401 means "up, but wants a key". The
 * key, if any, goes into the global config's `credentials` map (never a project file). The round
 * trip is the same ping-tool check `/doctor` runs: a server that answers but cannot call tools is
 * not usable by o4c, and it is better to learn that now than in the middle of a task.
 */
export const SETUP_DONE_KEY = 'setupDone';

export interface DetectedServer {
  name: string;
  url: string;
  state: 'up' | 'needs-key' | 'down';
  models: string[];
}

export const CANDIDATES: readonly { name: string; url: string }[] = [
  { name: 'llama.cpp (llama-server)', url: 'http://127.0.0.1:8080' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434' },
  { name: 'LM Studio', url: 'http://127.0.0.1:1234' },
];

export async function detectServers(
  extra: readonly string[] = [],
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  timeoutMs = 1500,
): Promise<DetectedServer[]> {
  const list = [...CANDIDATES, ...extra.filter((u) => u && !CANDIDATES.some((c) => c.url === u.replace(/\/+$/, ''))).map((url) => ({ name: 'Configured server', url: url.replace(/\/+$/, '') }))];
  return Promise.all(
    list.map(async (c): Promise<DetectedServer> => {
      try {
        const res = await fetchImpl(`${c.url}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401 || res.status === 403) return { ...c, state: 'needs-key', models: [] };
        if (!res.ok) return { ...c, state: 'down', models: [] };
        const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { name?: string }[] };
        const models = (body.data ?? []).map((m) => m.id ?? '').concat((body.models ?? []).map((m) => m.name ?? '')).filter(Boolean);
        return { ...c, state: 'up', models };
      } catch {
        return { ...c, state: 'down', models: [] };
      }
    }),
  );
}

export function describeServer(s: DetectedServer): string {
  if (s.state === 'needs-key') return `${s.name} at ${s.url} - up, needs an API key`;
  return `${s.name} at ${s.url} - ${s.models.length ? `model ${s.models[0]}${s.models.length > 1 ? ` (+${s.models.length - 1} more)` : ''}` : 'up'}`;
}

export interface SetupChoice {
  provider: 'local' | 'anthropic';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** The ping-tool round trip against the chosen server, before anything is saved. */
export async function roundTrip(choice: SetupChoice, probe?: (c: SetupChoice) => Promise<{ ok: boolean; detail: string }>): Promise<{ ok: boolean; detail: string }> {
  if (probe) return probe(choice);
  try {
    const provider = createProvider({ provider: choice.provider, baseUrl: choice.baseUrl, model: choice.model }, {}, process.env, choice.apiKey ? { local: choice.apiKey, anthropic: choice.apiKey } : {});
    return await new AgentLoop(provider, [], '').probeToolCall(AbortSignal.timeout(120_000));
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Saves the choice to the global config (the key into its credentials map). A trusted project's own
 * config.json may hold a copy of the same keys (it starts as a snapshot of global), which would hide
 * the new values - so a project scope that already has one of these keys is updated too.
 */
export async function saveSetup(store: ConfigStore, c: SetupChoice): Promise<void> {
  const set = async (key: string, value: unknown) => {
    await store.set('global', key, value);
    for (const scope of ['local', 'personal'] as const) {
      if (store.hasScope(scope) && (await store.readScope(scope))[key] !== undefined) await store.set(scope, key, value);
    }
  };
  await set('provider', c.provider);
  if (c.baseUrl) await set('baseUrl', c.baseUrl);
  if (c.model) await set('model', c.model);
  if (c.apiKey) {
    const current = (await store.readScope('global')).credentials;
    const map = { ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}) };
    map[c.provider] = c.apiKey;
    await store.set('global', 'credentials', map);
  }
  await store.set('global', SETUP_DONE_KEY, true);
}
