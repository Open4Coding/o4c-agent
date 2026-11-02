import type { ToolCall } from '../providers/types.js';

/**
 * Tool calls a model wrote into its reply as text instead of as structured calls (plan 0006 B2).
 * A local model does this when the server's parser misses its output - an extra blank line, a call
 * after prose the parser did not expect, a JSON form instead of the template's XML one - and the
 * turn then "ends" with the call printed on screen and nothing run.
 *
 * Three forms are recognised, each only for a tool the session has:
 *  - Qwen XML: `<tool_call><function=NAME><parameter=KEY>value</parameter>...</function></tool_call>`
 *    (the `<tool_call>` wrapper optional);
 *  - Hermes JSON: `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`;
 *  - a fenced JSON block holding exactly `{"name": ..., "arguments": {...}}`.
 * The XML and Hermes forms are ignored inside a fenced code block, where a model is showing an
 * example rather than making a call. Prose that merely names a tool is never a call.
 */

export interface ToolSchemaLike {
  name: string;
  inputSchema?: { properties?: Record<string, { type?: string | string[] }> };
}

export interface RecoveredCalls {
  calls: ToolCall[];
  /** The reply with the recovered call blocks removed. */
  text: string;
}

const FENCE = /```[^\n`]*\n[\s\S]*?```/g;
const XML_CALL = /(?:<tool_call>\s*)?<function=([\w.-]+)>\s*([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
const XML_PARAM = /<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
const HERMES_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const FENCED_JSON = /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/g;

let counter = 0;
function newId(): string {
  counter += 1;
  return `text_call_${Date.now().toString(36)}_${counter}`;
}

/** A text value converted to the type the tool's schema declares for it. */
function coerce(value: string, type: string | string[] | undefined): unknown {
  const t = Array.isArray(type) ? type.find((x) => x !== 'null') : type;
  if (t === 'number' || t === 'integer') {
    const n = Number(value.trim());
    return value.trim() !== '' && Number.isFinite(n) ? n : value;
  }
  if (t === 'boolean') {
    const v = value.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : value;
  }
  if (t === 'object' || t === 'array') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Ranges of fenced code blocks, so a match inside one can be skipped. */
function fenceRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(FENCE)].map((m) => [m.index!, m.index! + m[0].length]);
}

function inside(ranges: Array<[number, number]>, at: number): boolean {
  return ranges.some(([a, b]) => at >= a && at < b);
}

function fromJson(json: string, tools: Map<string, ToolSchemaLike>): ToolCall | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  const args = obj.arguments ?? obj.parameters;
  if (typeof obj.name !== 'string' || !tools.has(obj.name)) return undefined;
  if (!keys.every((k) => ['name', 'arguments', 'parameters'].includes(k))) return undefined;
  const input = typeof args === 'string' ? safeParse(args) : args;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return { id: newId(), name: obj.name, input: input as Record<string, unknown> };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function recoverTextToolCalls(text: string, toolList: readonly ToolSchemaLike[]): RecoveredCalls {
  const tools = new Map(toolList.map((t) => [t.name, t]));
  const found: Array<{ start: number; end: number; call: ToolCall }> = [];
  const fences = fenceRanges(text);

  for (const m of text.matchAll(XML_CALL)) {
    if (inside(fences, m.index!)) continue;
    const tool = tools.get(m[1]);
    if (!tool) continue;
    const input: Record<string, unknown> = {};
    for (const p of m[2].matchAll(XML_PARAM)) input[p[1]] = coerce(p[2], tool.inputSchema?.properties?.[p[1]]?.type);
    found.push({ start: m.index!, end: m.index! + m[0].length, call: { id: newId(), name: tool.name, input } });
  }
  for (const m of text.matchAll(HERMES_CALL)) {
    if (inside(fences, m.index!) || found.some((f) => m.index! >= f.start && m.index! < f.end)) continue;
    const call = fromJson(m[1], tools);
    if (call) found.push({ start: m.index!, end: m.index! + m[0].length, call });
  }
  if (found.length === 0) {
    for (const m of text.matchAll(FENCED_JSON)) {
      const call = fromJson(m[1], tools);
      if (call) found.push({ start: m.index!, end: m.index! + m[0].length, call });
    }
  }
  if (found.length === 0) return { calls: [], text };

  found.sort((a, b) => a.start - b.start);
  let rest = '';
  let at = 0;
  for (const f of found) {
    rest += text.slice(at, f.start);
    at = f.end;
  }
  rest += text.slice(at);
  return { calls: found.map((f) => f.call), text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}
