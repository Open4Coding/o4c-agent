import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isThinkLevel, type ThinkLevel } from '../agent/thinkLevel.js';
import type { SamplingProfiles } from '../agent/sampling.js';

/**
 * The models registry (plan 0006 E19): what o4c knows about each model, in one file the user can
 * read and edit - `~/.o4c/models.json`, keyed by the model id the server reports. Machine-wide,
 * because a model is the same model in every project.
 *
 * Each field is a default that something more specific overrides: `contextWindow` loses to a
 * `contextWindow` in config.json but beats the server's probe; `thinkLevel` is the level a model
 * starts at until `/think` saves one for it; `sampling` is used when config.json has no
 * `localSampling`. `price` (per million tokens) only feeds `/stats`. `name` and `comment` are for
 * people. `/config-model` writes the current model's entry, `/view-model` shows it beside what was
 * detected.
 */
export interface ModelEntry {
  name?: string;
  comment?: string;
  contextWindow?: number;
  thinkLevel?: ThinkLevel;
  sampling?: SamplingProfiles;
  price?: { inputPerM: number; outputPerM: number };
}

export function modelsFile(): string {
  return join(homedir(), '.o4c', 'models.json');
}

export function readModels(file = modelsFile()): Record<string, ModelEntry> {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ModelEntry>) : {};
  } catch {
    return {};
  }
}

/** The entry for `model`, with anything malformed dropped rather than trusted. */
export function modelEntry(model: string | undefined, file = modelsFile()): ModelEntry | undefined {
  if (!model) return undefined;
  const raw = readModels(file)[model];
  if (!raw || typeof raw !== 'object') return undefined;
  const e: ModelEntry = {};
  if (typeof raw.name === 'string') e.name = raw.name;
  if (typeof raw.comment === 'string') e.comment = raw.comment;
  if (typeof raw.contextWindow === 'number' && raw.contextWindow >= 1024) e.contextWindow = Math.floor(raw.contextWindow);
  if (isThinkLevel(raw.thinkLevel)) e.thinkLevel = raw.thinkLevel;
  if (raw.sampling && typeof raw.sampling === 'object') e.sampling = raw.sampling;
  if (raw.price && typeof raw.price.inputPerM === 'number' && typeof raw.price.outputPerM === 'number') e.price = { inputPerM: raw.price.inputPerM, outputPerM: raw.price.outputPerM };
  return e;
}

/** Merges `fields` into `model`'s entry and saves; other models' entries are untouched. */
export function setModelFields(model: string, fields: Partial<ModelEntry>, file = modelsFile()): ModelEntry {
  const all = readModels(file);
  const next: ModelEntry = { ...(all[model] ?? {}), ...fields };
  for (const k of Object.keys(next) as (keyof ModelEntry)[]) if (next[k] === undefined) delete next[k];
  all[model] = next;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf-8');
  return next;
}

const ARG = /(\w+)=(?:"([^"]*)"|(\S*))/g;

/**
 * `/config-model name="Qwen 27B" context=229376 think=med price_in=0.3 price_out=1.2 comment="..."`.
 * `key=` with nothing after it clears that field.
 */
export function parseModelArgs(text: string): { fields: Partial<ModelEntry>; errors: string[] } {
  const fields: Partial<ModelEntry> = {};
  const errors: string[] = [];
  let priceIn: number | undefined;
  let priceOut: number | undefined;
  for (const m of text.matchAll(ARG)) {
    const key = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? '';
    const num = Number(value);
    if (key === 'name' || key === 'comment') fields[key] = value || undefined;
    else if (key === 'context') {
      if (!value) fields.contextWindow = undefined;
      else if (Number.isInteger(num) && num >= 1024) fields.contextWindow = num;
      else errors.push(`context=${value}: a whole number of tokens, at least 1024.`);
    } else if (key === 'think') {
      if (!value) fields.thinkLevel = undefined;
      else if (isThinkLevel(value)) fields.thinkLevel = value;
      else errors.push(`think=${value}: one of nothink, low, med, high, xhigh.`);
    } else if (key === 'price_in' || key === 'price_out') {
      if (!Number.isFinite(num) || num < 0 || value === '') errors.push(`${key}=${value}: a price per million tokens, 0 or more.`);
      else if (key === 'price_in') priceIn = num;
      else priceOut = num;
    } else errors.push(`Unknown field "${key}" - name, comment, context, think, price_in, price_out.`);
  }
  if (priceIn !== undefined || priceOut !== undefined) {
    if (priceIn === undefined || priceOut === undefined) errors.push('Give price_in and price_out together.');
    else fields.price = { inputPerM: priceIn, outputPerM: priceOut };
  }
  if (Object.keys(fields).length === 0 && errors.length === 0) errors.push('Nothing to set.');
  return { fields, errors };
}

/** What a spend cost at this entry's price, or undefined when it has none. */
export function costOf(spend: { input: number; output: number }, entry: ModelEntry | undefined): number | undefined {
  if (!entry?.price) return undefined;
  return (spend.input * entry.price.inputPerM + spend.output * entry.price.outputPerM) / 1_000_000;
}

/** `/view-model`: the registry entry beside what o4c detected for this model. */
export function describeModel(
  model: string,
  entry: ModelEntry | undefined,
  detected: { provider: string; contextWindow?: number; thinkCaps?: string },
): string[] {
  const e = entry ?? {};
  const field = (label: string, value: string | undefined) => `  ${label.padEnd(15)} ${value ?? '-'}`;
  return [
    `Model ${model} (${detected.provider}):`,
    '  In the registry (/config-model to set; file ' + modelsFile() + '):',
    field('name', e.name),
    field('comment', e.comment),
    field('context', e.contextWindow?.toLocaleString()),
    field('think level', e.thinkLevel),
    field('sampling', e.sampling ? JSON.stringify(e.sampling) : undefined),
    field('price / 1M', e.price ? `${e.price.inputPerM} in, ${e.price.outputPerM} out` : undefined),
    '  Detected:',
    field('context', detected.contextWindow?.toLocaleString()),
    field('think controls', detected.thinkCaps),
  ];
}
