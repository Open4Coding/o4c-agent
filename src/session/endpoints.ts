import { AgentLoop } from '../agent/loop.js';
import { COPILOT_CHAT_PATH, copilotHeaders } from '../providers/copilot.js';
import { LocalProvider } from '../providers/local.js';
import type { ConfigStore } from './configStore.js';

/**
 * Named endpoints: hosted OpenAI-compatible APIs o4c can run against, beside the built-in `local`
 * (a llama.cpp-style server) and `anthropic`. Kept in the global config, keys in the credentials
 * map under the endpoint's own name - never in a project file:
 *
 *   "endpoints": {
 *     "bedrock": { "url": "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", "model": "openai.gpt-oss-120b-1:0" }
 *   },
 *   "credentials": { "bedrock": "<Bedrock API key>" },
 *   "provider": "bedrock"
 *
 * An endpoint is selected exactly like a built-in provider: `"provider": "<name>"` or `-p <name>`.
 * `/endpoint-add` writes these; `/endpoint` lists them and switches.
 */
export const ENDPOINTS_KEY = 'endpoints';
export const BUILTIN_PROVIDERS = ['local', 'anthropic', 'mock'] as const;
/** When neither the endpoint nor the models registry says: what current hosted models offer at least. */
export const HOSTED_DEFAULT_CONTEXT_WINDOW = 128_000;

export interface Endpoint {
  name: string;
  /** What the user gave, normalised: no trailing slash, no `/chat/completions`. Ends in `/v1` or not. */
  url: string;
  /** The part before `/v1`, which is what the provider appends its paths to. */
  baseUrl: string;
  model: string;
  contextWindow?: number;
  /**
   * GitHub Copilot: the GitHub host it signs in to (`github.com` or `<name>.ghe.com`). The token is
   * looked up on every start (providers/copilot.ts) rather than only read from credentials, so a
   * GitHub CLI login that is renewed keeps working; `url` is the account's Copilot API base.
   */
  copilot?: string;
}

/** `https://host/openai/v1/chat/completions/` -> `https://host/openai/v1`. */
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
    .replace(/\/+$/, '');
}

export function baseUrlOf(url: string): string {
  return normalizeUrl(url).replace(/\/v1$/, '');
}

export function validName(name: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return 'Use a short lowercase name: letters, digits and dashes, starting with a letter.';
  if ((BUILTIN_PROVIDERS as readonly string[]).includes(name)) return `"${name}" is a built-in provider name; choose another.`;
  return undefined;
}

export function parseEndpoints(value: unknown): { endpoints: Endpoint[]; problems: string[] } {
  const endpoints: Endpoint[] = [];
  const problems: string[] = [];
  if (value === undefined) return { endpoints, problems };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { endpoints, problems: ['config.json endpoints must be an object of { "<name>": { "url": ..., "model": ... } }.'] };
  }
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const e = raw as Record<string, unknown> | null;
    const bad = validName(name);
    if (bad) problems.push(`config.json endpoints.${name}: ${bad}`);
    else if (!e || typeof e.url !== 'string' || !/^https?:\/\//.test(e.url)) problems.push(`config.json endpoints.${name}: needs "url" (http:// or https://).`);
    else if (typeof e.model !== 'string' || !e.model) problems.push(`config.json endpoints.${name}: needs "model".`);
    else {
      endpoints.push({
        name,
        url: normalizeUrl(e.url),
        baseUrl: baseUrlOf(e.url),
        model: e.model,
        ...(typeof e.contextWindow === 'number' && e.contextWindow > 0 ? { contextWindow: e.contextWindow } : {}),
        ...(typeof e.copilot === 'string' && e.copilot ? { copilot: e.copilot } : {}),
      });
    }
  }
  return { endpoints, problems };
}

/** The endpoint a provider name selects, if it names one. */
export function endpointFor(config: Readonly<Record<string, unknown>>, provider: string): Endpoint | undefined {
  if ((BUILTIN_PROVIDERS as readonly string[]).includes(provider)) return undefined;
  return parseEndpoints(config[ENDPOINTS_KEY]).endpoints.find((e) => e.name === provider);
}

export interface EndpointPreset {
  id: string;
  label: string;
  /** The suggested endpoint name. */
  name: string;
  /** The URL, given the region when the preset has regions; undefined = the user types it. */
  url?: (region: string) => string;
  regions?: readonly string[];
  /** Model ids to offer; the list can always be bypassed by typing one. */
  models: readonly string[];
  /** Whether `GET /v1/models` answers, so the offered list can come from the endpoint itself. */
  listsModels: boolean;
  keyHelp: string;
  /** Signs in with a GitHub login and finds its own URL and models (providers/copilot.ts). */
  copilot?: true;
}

const AWS_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1', 'ap-southeast-2'] as const;

/**
 * Amazon Bedrock per AWS's Chat Completions guide (checked 2026-11-07): `bedrock-runtime` is the
 * recommended endpoint and has no models list; `bedrock-mantle` is the compatibility one and does.
 * Both take a Bedrock API key as a Bearer token. GitHub Copilot signs in with the user's GitHub
 * login instead of a key, on github.com or a `<name>.ghe.com` enterprise - see providers/copilot.ts.
 */
export const PRESETS: readonly EndpointPreset[] = [
  {
    id: 'bedrock',
    label: 'Amazon Bedrock - bedrock-runtime, the recommended endpoint (needs a Bedrock API key)',
    name: 'bedrock',
    url: (r) => `https://bedrock-runtime.${r}.amazonaws.com/openai/v1`,
    regions: AWS_REGIONS,
    models: ['openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b-1:0'],
    listsModels: false,
    keyHelp: 'An Amazon Bedrock API key (Bedrock console > API keys)',
  },
  {
    id: 'bedrock-mantle',
    label: 'Amazon Bedrock - bedrock-mantle, for models runtime does not serve (needs a Bedrock API key)',
    name: 'bedrock-mantle',
    url: (r) => `https://bedrock-mantle.${r}.api.aws/v1`,
    regions: AWS_REGIONS,
    models: ['openai.gpt-oss-120b'],
    listsModels: true,
    keyHelp: 'An Amazon Bedrock API key (Bedrock console > API keys)',
  },
  {
    id: 'openai',
    label: 'OpenAI (needs an OpenAI API key)',
    name: 'openai',
    url: () => 'https://api.openai.com/v1',
    models: [],
    listsModels: true,
    keyHelp: 'An OpenAI API key (platform.openai.com > API keys)',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter - many providers behind one key',
    name: 'openrouter',
    url: () => 'https://openrouter.ai/api/v1',
    models: [],
    listsModels: true,
    keyHelp: 'An OpenRouter API key (openrouter.ai > Keys)',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot - your Copilot plan on github.com or a <name>.ghe.com enterprise (signs in with your GitHub login)',
    name: 'copilot',
    models: [],
    listsModels: true,
    keyHelp: 'A GitHub token',
    copilot: true,
  },
  {
    id: 'custom',
    label: 'Another OpenAI-compatible endpoint - type its URL',
    name: 'custom',
    models: [],
    listsModels: true,
    keyHelp: 'Its API key (leave empty if it needs none)',
  },
];

/** `GET <url>/models` - the ids it serves, or undefined when it does not say. */
export async function listModels(
  url: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<string[] | undefined> {
  const base = normalizeUrl(url);
  try {
    const res = await fetchImpl(`${/\/v1$/.test(base) ? base : `${base}/v1`}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
    return ids.length ? ids.sort() : undefined;
  } catch {
    return undefined;
  }
}

/** Saves an endpoint (and its key) to the global config; `select` also makes it the provider. */
export async function saveEndpoint(
  store: ConfigStore,
  endpoint: { name: string; url: string; model: string; contextWindow?: number; copilot?: string },
  apiKey: string | undefined,
  select: boolean,
): Promise<void> {
  const global = await store.readScope('global');
  const current = global[ENDPOINTS_KEY];
  const map = { ...(current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {}) };
  map[endpoint.name] = {
    url: normalizeUrl(endpoint.url),
    model: endpoint.model,
    ...(endpoint.contextWindow ? { contextWindow: endpoint.contextWindow } : {}),
    ...(endpoint.copilot ? { copilot: endpoint.copilot } : {}),
  };
  await store.set('global', ENDPOINTS_KEY, map);
  if (apiKey) {
    const creds = global.credentials;
    await store.set('global', 'credentials', { ...(creds && typeof creds === 'object' ? (creds as Record<string, unknown>) : {}), [endpoint.name]: apiKey });
  }
  if (select) await selectProvider(store, endpoint.name);
}

/**
 * Makes `provider` the one o4c starts with. A trusted project's config may hold its own copy of
 * `provider` (it starts as a snapshot of global), which would hide the change - so a project scope
 * that already has the key is updated too, as `/setup` does.
 */
export async function selectProvider(store: ConfigStore, provider: string): Promise<void> {
  await store.set('global', 'provider', provider);
  for (const scope of ['local', 'personal'] as const) {
    if (store.hasScope(scope) && (await store.readScope(scope)).provider !== undefined) await store.set(scope, 'provider', provider);
  }
}

/** One line per choice for `/endpoint`: the built-ins that are set up, then every endpoint. */
export function describeEndpoint(e: Endpoint): string {
  return `${e.name} - ${e.model} at ${e.copilot ? `GitHub Copilot (${e.copilot})` : e.url}`;
}

/**
 * Where a hosted provider sends its requests: `<base>/v1/chat/completions` for an OpenAI-compatible
 * API, `<url>/chat/completions` plus Copilot's own headers for GitHub Copilot.
 */
export function hostedRoute(endpoint: { url: string; copilot?: string }): { baseUrl: string; chatPath?: string; headers?: Record<string, string> } {
  return endpoint.copilot
    ? { baseUrl: normalizeUrl(endpoint.url), chatPath: COPILOT_CHAT_PATH, headers: copilotHeaders() }
    : { baseUrl: baseUrlOf(endpoint.url) };
}

/** One real tool call against the endpoint, before anything is saved - the check /setup and /doctor make. */
export async function checkEndpoint(
  endpoint: { name: string; url: string; model: string; copilot?: string },
  apiKey: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const provider = new LocalProvider({ hosted: endpoint.name, ...hostedRoute(endpoint), apiKey, modelId: endpoint.model });
    return await new AgentLoop(provider, [], '').probeToolCall(AbortSignal.timeout(120_000));
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
