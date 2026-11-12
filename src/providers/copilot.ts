import { execFile } from 'node:child_process';
import { packageVersion } from '../packageRoot.js';

/**
 * GitHub Copilot as an endpoint: the same streaming Chat Completions client as any hosted API
 * (LocalProvider with `hosted`), pointed at the Copilot API of the user's own plan and signed in
 * with their GitHub login - no SDK, no second agent loop.
 *
 * Checked live 2026-11-11 against a Copilot Free account: a GitHub OAuth token (`gho_`, what
 * `gh auth token` prints) is accepted as the Bearer token as-is; `GET <api.host>/copilot_internal/user`
 * names the account's own API base (`endpoints.api`, e.g. https://api.individual.githubcopilot.com);
 * `GET <base>/models` lists the models with their policy and the endpoints each serves; chat is at
 * `<base>/chat/completions` (no `/v1`), streaming tool calls in the standard OpenAI shape. Models
 * served only on `/responses` (the GPT-5 and later family) are not reachable this way yet.
 *
 * A `<name>.ghe.com` enterprise (GitHub Enterprise Cloud with data residency) has its own hosts:
 * `api.<name>.ghe.com` for the account, `copilot-api.<name>.ghe.com` for the models.
 */

export const COPILOT_CHAT_PATH = '/chat/completions';

export function copilotHeaders(): Record<string, string> {
  return {
    'Copilot-Integration-Id': 'copilot-developer-cli',
    'Editor-Version': `o4c/${packageVersion()}`,
  };
}

/** `https://Name.ghe.com/` -> `name.ghe.com`; empty means github.com. */
export function normalizeHost(host: string | undefined): string {
  const h = (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return h === '' || h === 'www.github.com' ? 'github.com' : h;
}

export function validHost(host: string): string | undefined {
  return host === 'github.com' || /^[a-z0-9][a-z0-9-]*\.ghe\.com$/.test(host)
    ? undefined
    : 'Use github.com, or your enterprise\'s <name>.ghe.com host.';
}

/** The REST API host the account is read from. */
export function restApiFor(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://api.${host}`;
}

/** Where the models live when the account does not say. */
export function defaultCopilotApi(host: string): string {
  return host === 'github.com' ? 'https://api.githubcopilot.com' : `https://copilot-api.${host}`;
}

export type RunGh = (args: string[]) => Promise<string | undefined>;

/** `gh <args>` stdout, or undefined when gh is missing, fails or is not signed in. */
export const runGh: RunGh = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });

export interface CopilotToken {
  token: string;
  /** Where it came from, for messages - never the token itself. */
  source: string;
}

/**
 * The GitHub token for `host`, first found: COPILOT_GITHUB_TOKEN, then GH_TOKEN / GITHUB_TOKEN
 * (github.com) or GH_ENTERPRISE_TOKEN (an enterprise host) - the variables the gh and Copilot CLIs
 * read - then a token saved by /endpoint-add, then the GitHub CLI's own login (`gh auth token`).
 */
export async function resolveCopilotToken(
  host: string,
  saved: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  gh: RunGh = runGh,
): Promise<CopilotToken | undefined> {
  const vars = host === 'github.com' ? ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] : ['COPILOT_GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];
  for (const v of vars) {
    const value = env[v]?.trim();
    if (value) return { token: value, source: v };
  }
  if (saved) return { token: saved, source: 'the token saved with /endpoint-add' };
  const fromGh = await gh(['auth', 'token', '--hostname', host]);
  return fromGh ? { token: fromGh, source: `your GitHub CLI login for ${host}` } : undefined;
}

export interface CopilotAccount {
  /** The models API base, no trailing slash. */
  api: string;
  /** e.g. "individual", "business"; undefined when the account could not be read. */
  plan?: string;
}

/** The account's own Copilot API base; the documented default when the account cannot be read. */
export async function copilotAccount(host: string, token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<CopilotAccount> {
  try {
    const res = await fetchImpl(`${restApiFor(host)}/copilot_internal/user`, {
      headers: { Authorization: `token ${token}`, ...copilotHeaders() },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { copilot_plan?: unknown; endpoints?: { api?: unknown } };
      const api = typeof body.endpoints?.api === 'string' && /^https:\/\//.test(body.endpoints.api) ? body.endpoints.api.replace(/\/+$/, '') : defaultCopilotApi(host);
      return { api, ...(typeof body.copilot_plan === 'string' ? { plan: body.copilot_plan } : {}) };
    }
  } catch {
    // Fall through to the default host.
  }
  return { api: defaultCopilotApi(host) };
}

export interface CopilotModel {
  id: string;
  contextWindow?: number;
}

export interface CopilotModels {
  /** Chat models this account may use over Chat Completions with tools, best first as listed. */
  usable: CopilotModel[];
  /** Enabled for the account but served only on `/responses`, which o4c does not speak yet. */
  responsesOnly: string[];
  /** Turned off by a policy (the user's settings, or their organisation's). */
  disabled: string[];
}

interface RawModel {
  id?: unknown;
  version?: unknown;
  model_picker_category?: unknown;
  policy?: { state?: unknown };
  supported_endpoints?: unknown;
  capabilities?: { type?: unknown; supports?: { tool_calls?: unknown }; limits?: { max_prompt_tokens?: unknown; max_context_window_tokens?: unknown } };
}

/**
 * The list has no "this account can call it" flag (a model can be listed, enabled and still be
 * refused), so the one real tool call /endpoint-add makes is the test. What helps the choice: the
 * models GitHub's own picker sorts into a category come first, and a dated snapshot listed beside
 * its plain name (`gpt-4.1-2025-04-14` beside `gpt-4.1`) is left out.
 */
export function sortCopilotModels(data: RawModel[]): CopilotModels {
  const out: CopilotModels = { usable: [], responsesOnly: [], disabled: [] };
  const seen = new Set<string>();
  const snapshots = new Set(data.filter((m) => typeof m.version === 'string' && m.version !== m.id).map((m) => m.version as string));
  const curated = new Set<string>();
  for (const m of data) {
    const id = typeof m.id === 'string' ? m.id : '';
    if (!id || seen.has(id) || snapshots.has(id)) continue;
    if (typeof m.model_picker_category === 'string') curated.add(id);
    seen.add(id);
    const caps = m.capabilities ?? {};
    if (caps.type !== undefined && caps.type !== 'chat') continue;
    if (caps.supports?.tool_calls !== true) continue;
    if (m.policy?.state === 'disabled') {
      out.disabled.push(id);
      continue;
    }
    const endpoints = Array.isArray(m.supported_endpoints) ? (m.supported_endpoints as unknown[]) : [];
    // An empty list is the older models, which all answer Chat Completions.
    if (endpoints.length && !endpoints.includes(COPILOT_CHAT_PATH)) {
      out.responsesOnly.push(id);
      continue;
    }
    // max_prompt_tokens is what a request may carry; the whole window also holds the answer.
    const limit = caps.limits?.max_prompt_tokens ?? caps.limits?.max_context_window_tokens;
    out.usable.push({ id, ...(typeof limit === 'number' && limit > 0 ? { contextWindow: limit } : {}) });
  }
  out.usable = [...out.usable.filter((m) => curated.has(m.id)), ...out.usable.filter((m) => !curated.has(m.id))];
  return out;
}

export async function copilotModels(api: string, token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<CopilotModels | undefined> {
  try {
    const res = await fetchImpl(`${api}/models`, {
      headers: { Authorization: `Bearer ${token}`, ...copilotHeaders() },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: RawModel[] };
    return sortCopilotModels(body.data ?? []);
  } catch {
    return undefined;
  }
}

/** What to tell someone with no token for `host`. */
export function copilotLoginHelp(host: string): string {
  return (
    `No GitHub login found for ${host}. Either sign in with the GitHub CLI - gh auth login --hostname ${host} - ` +
    `or create a token at https://${host}/settings/personal-access-tokens/new and paste it here, ` +
    'or set COPILOT_GITHUB_TOKEN.'
  );
}
