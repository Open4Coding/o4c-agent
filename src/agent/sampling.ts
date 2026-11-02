import type { ThinkLevel } from './thinkLevel.js';

/**
 * Sampling settings sent with each local request (plan 0006 A18). Until A18 o4c sent none, so every
 * request ran on llama-server's own defaults (temperature 0.8, top_k 40, top_p 0.95, min_p 0.05),
 * which are not what the model's makers recommend.
 *
 * Model-agnostic: a profile is only sent when one is known for the model - from config
 * (`localSampling`, either shape below) or from the table of published recommendations - and a model
 * nobody configured keeps the server's defaults, as before.
 */
export interface SamplingProfile {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
}

export interface SamplingProfiles {
  /** Any level with thinking on. */
  thinking?: SamplingProfile;
  /** `nothink`. */
  nothink?: SamplingProfile;
}

/**
 * Published recommendations, by model id pattern. Qwen3.x: copied from the Qwen3.8-27B model card's
 * "Best practices" (checked in the checkpoint's README on PHOEBE, 2026-11-02):
 *   Thinking: temperature=1.0, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0
 *   Non-thinking: temperature=0.7, top_p=0.80, top_k=20, min_p=0.0, presence_penalty=1.5, repetition_penalty=1.0
 *
 * One deliberate deviation: no presence_penalty for non-thinking. Measured on PHOEBE (llama.cpp
 * b10868, 4 coding prompts): 51.5 t/s with it against 62-63 t/s without - a 17% decode loss, likely
 * because a penalty sampler takes the sampling off the GPU. The thinking profile costs nothing
 * (59.6 vs 59.8). Its purpose, less repetition, is covered by the repetition guard (B17); put it back
 * with config `localSampling` if wanted.
 */
export const KNOWN_SAMPLING: ReadonlyArray<{ pattern: RegExp; profiles: SamplingProfiles }> = [
  {
    pattern: /qwen3/i,
    profiles: {
      thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1.0 },
      nothink: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, repeat_penalty: 1.0 },
    },
  },
];

/** The profile for this model and level, or undefined to leave the server's defaults. */
export function samplingFor(modelId: string | undefined, level: ThinkLevel | undefined, configured?: unknown): SamplingProfile | undefined {
  const profiles = isProfiles(configured) ? configured : KNOWN_SAMPLING.find((k) => modelId && k.pattern.test(modelId))?.profiles;
  if (!profiles) return undefined;
  return level === 'nothink' ? profiles.nothink : profiles.thinking;
}

function isProfiles(value: unknown): value is SamplingProfiles {
  return !!value && typeof value === 'object' && ('thinking' in value || 'nothink' in value);
}

/** One line for `/status`-style reports. */
export function describeSampling(profile: SamplingProfile | undefined): string {
  if (!profile) return 'server defaults';
  return Object.entries(profile)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}
