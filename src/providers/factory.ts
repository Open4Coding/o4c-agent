import { AnthropicProvider } from './anthropic.js';
import { LocalProvider } from './local.js';
import { MockProvider } from './mock.js';
import type { LLMProvider } from './types.js';

/**
 * `createProvider()` (plan 0006 F1): one place that turns a provider description into a provider,
 * used for the `fallbackChain` entries in config.json, e.g.
 *
 *   "fallbackChain": [
 *     { "provider": "local", "baseUrl": "http://other-box:8080" },
 *     { "provider": "anthropic", "model": "claude-sonnet-5-5" }
 *   ]
 *
 * An entry's key comes from the `credentials` map entry it names (`credential`, plan 0006 F2), else
 * the environment variable it names (`apiKeyEnv`), else O4C_LOCAL_API_KEY / the map's `anthropic` -
 * never from a key written into the fallback entry itself.
 */
export interface ProviderSpec {
  provider: 'local' | 'anthropic' | 'mock';
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  /** F2: a name in the `credentials` map. */
  credential?: string;
}

export interface SharedProviderOptions {
  maxTokens?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export function parseProviderSpecs(value: unknown): { specs: ProviderSpec[]; errors: string[] } {
  const specs: ProviderSpec[] = [];
  const errors: string[] = [];
  if (value === undefined) return { specs, errors };
  if (!Array.isArray(value)) return { specs, errors: ['fallbackChain must be a list of { "provider": "local" | "anthropic", ... }.'] };
  value.forEach((v, i) => {
    const o = v as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || !['local', 'anthropic', 'mock'].includes(String(o.provider))) {
      errors.push(`fallbackChain[${i}]: "provider" must be "local" or "anthropic".`);
      return;
    }
    if (o.provider === 'local' && typeof o.baseUrl !== 'string') {
      errors.push(`fallbackChain[${i}]: a local fallback needs "baseUrl".`);
      return;
    }
    specs.push({
      provider: o.provider as ProviderSpec['provider'],
      ...(typeof o.baseUrl === 'string' ? { baseUrl: o.baseUrl } : {}),
      ...(typeof o.model === 'string' ? { model: o.model } : {}),
      ...(typeof o.apiKeyEnv === 'string' ? { apiKeyEnv: o.apiKeyEnv } : {}),
      ...(typeof o.credential === 'string' ? { credential: o.credential } : {}),
    });
  });
  return { specs, errors };
}

export function createProvider(
  spec: ProviderSpec,
  shared: SharedProviderOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  credentials: Record<string, string> = {},
): LLMProvider {
  if (spec.provider === 'mock') return new MockProvider();
  const named = spec.credential ? credentials[spec.credential] : undefined;
  if (spec.provider === 'local') {
    return new LocalProvider({
      baseUrl: spec.baseUrl!,
      apiKey: named ?? (spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined) ?? env.O4C_LOCAL_API_KEY,
      maxTokens: shared.maxTokens,
      connectTimeoutMs: shared.connectTimeoutMs,
      idleTimeoutMs: shared.idleTimeoutMs,
      modelId: spec.model,
    });
  }
  return new AnthropicProvider({
    apiKey: named ?? (spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined) ?? credentials.anthropic,
    model: spec.model,
    maxTokens: shared.maxTokens,
    timeoutMs: shared.connectTimeoutMs && shared.connectTimeoutMs > 0 ? shared.connectTimeoutMs : undefined,
  });
}
