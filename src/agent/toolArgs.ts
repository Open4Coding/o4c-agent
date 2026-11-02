/**
 * Tool-call checks before a call reaches approval or execution (plan 0006 B4): the tool name
 * matched loosely when it is unambiguous, the arguments checked against the tool's schema with the
 * obvious coercions applied, and an error the model can act on when neither works.
 */

export interface SchemaTool {
  name: string;
  inputSchema?: {
    properties?: Record<string, { type?: string | string[] }>;
    required?: readonly string[];
  };
}

const fold = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '');

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** Up to three names close to `name`: same after folding, containing it, or within a few edits. */
export function closestNames(name: string, names: readonly string[]): string[] {
  const f = fold(name);
  return names
    .map((n) => {
      const g = fold(n);
      if (g === f) return { n, d: 0 };
      if (g.includes(f) || f.includes(g)) return { n, d: 1 };
      // A misspelt start ("reed" for read_file) is as telling as a misspelt whole name.
      return { n, d: Math.min(distance(g, f), distance(g.slice(0, f.length), f) + 1) };
    })
    .filter((x) => x.d <= Math.max(2, Math.floor(f.length / 3)))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 3)
    .map((x) => x.n);
}

/** The tool a call means: exact name, else the single tool equal after case and -/_ folding. */
export function resolveTool<T extends SchemaTool>(name: string, tools: readonly T[]): T | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const folded = tools.filter((t) => fold(t.name) === fold(name));
  return folded.length === 1 ? folded[0] : undefined;
}

export function unknownToolMessage(name: string, names: readonly string[]): string {
  const close = closestNames(name, names);
  return `Error: there is no tool named "${name}".${close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(' or ')}?` : ''} Available tools: ${names.join(', ')}.`;
}

function typeOf(t: string | string[] | undefined): string | undefined {
  return Array.isArray(t) ? t.find((x) => x !== 'null') : t;
}

function fits(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

/** `value` as `type` when the conversion is unambiguous, else undefined. */
function coerce(value: unknown, type: string): unknown {
  if (typeof value === 'string') {
    const v = value.trim();
    if ((type === 'number' || type === 'integer') && v !== '' && Number.isFinite(Number(v))) {
      const n = Number(v);
      return type === 'integer' && !Number.isInteger(n) ? undefined : n;
    }
    if (type === 'boolean' && (v === 'true' || v === 'false')) return v === 'true';
    if (type === 'array' || type === 'object') {
      try {
        const parsed = JSON.parse(v) as unknown;
        return fits(parsed, type) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
  if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  return undefined;
}

export interface ArgCheck {
  /** The arguments with coercions applied. */
  input: Record<string, unknown>;
  /** Problems that stop the call, one sentence each; empty when it may run. */
  errors: string[];
}

/**
 * Checks top-level arguments against the schema. A missing required argument or a value of the
 * wrong type that cannot be converted is an error; an argument the schema does not list is
 * ignored, unless a required one is missing and the stray one looks like it was meant for it.
 */
export function checkArgs(input: Record<string, unknown>, tool: SchemaTool): ArgCheck {
  const props = tool.inputSchema?.properties ?? {};
  const out: Record<string, unknown> = { ...input };
  const errors: string[] = [];
  const extras = Object.keys(input).filter((k) => !(k in props));
  for (const key of tool.inputSchema?.required ?? []) {
    if (out[key] !== undefined && out[key] !== null) continue;
    const meant = closestNames(key, extras)[0];
    errors.push(`missing required argument "${key}"${meant ? ` (you passed "${meant}" - did you mean "${key}"?)` : ''}`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const type = typeOf(spec.type);
    if (!type || out[key] === undefined || out[key] === null || fits(out[key], type)) continue;
    const converted = coerce(out[key], type);
    if (converted === undefined) errors.push(`"${key}" must be ${type === 'integer' ? 'an integer' : type === 'array' || type === 'object' ? `an ${type}` : `a ${type}`}, not ${JSON.stringify(out[key]).slice(0, 60)}`);
    else out[key] = converted;
  }
  return { input: out, errors };
}
