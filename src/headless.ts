import type { AgentEvent } from './agent/loop.js';

/**
 * The headless contract (plan 0006 H1) - what a script can rely on from `o4c "prompt"`:
 *
 * - `--output-format text` (default: the event lines, then `--- final ---` and the answer),
 *   `json` (one JSON object at the end, nothing else on stdout) or `stream-json` (one JSON line per
 *   event as it happens, then the result line).
 * - Exit codes: 0 done, 1 error, 2 a tool needed approval nobody could give (or was outside
 *   --allowed-tools), 3 the step limit was reached (the summary is still printed).
 * - `--max-turns N`, `--permission-mode deny-ask|plan`, `--allowed-tools a,b`, `--json-schema file`
 *   (the final answer re-shaped into JSON that matches it, by constrained decoding).
 * - stdin: with no prompt, piped stdin IS the prompt; with a prompt, `--stdin` adds it after the
 *   prompt as context. Never read otherwise, so a caller that leaves stdin open cannot hang o4c.
 */
export type OutputFormat = 'text' | 'json' | 'stream-json';
export type PermissionMode = 'deny-ask' | 'plan';

export const EXIT = { done: 0, error: 1, refused: 2, stepLimit: 3 } as const;

export function parseOutputFormat(v: unknown): OutputFormat | undefined {
  return v === undefined ? 'text' : v === 'text' || v === 'json' || v === 'stream-json' ? v : undefined;
}

export function parsePermissionMode(v: unknown): PermissionMode | undefined {
  return v === undefined ? 'deny-ask' : v === 'deny-ask' || v === 'plan' ? v : undefined;
}

export function parseAllowedTools(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
}

export interface RunFacts {
  error?: string;
  refusals: string[];
  stepLimit: boolean;
}

export function exitCodeFor(f: RunFacts): number {
  if (f.error) return EXIT.error;
  if (f.refusals.length) return EXIT.refused;
  if (f.stepLimit) return EXIT.stepLimit;
  return EXIT.done;
}

export function resultObject(o: {
  result: unknown;
  facts: RunFacts;
  usage: { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number };
  toolCalls: number;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    type: 'result',
    exit_code: exitCodeFor(o.facts),
    is_error: Boolean(o.facts.error),
    result: o.result,
    ...(o.facts.error ? { error: o.facts.error } : {}),
    refusals: o.facts.refusals,
    step_limit_reached: o.facts.stepLimit,
    tool_calls: o.toolCalls,
    usage: o.usage,
    ...(o.sessionId ? { session_id: o.sessionId } : {}),
  };
}

/** One stream-json line for an event. */
export function eventLine(event: AgentEvent): string {
  return `${JSON.stringify({ type: 'event', event })}\n`;
}

/** All of stdin, for the cases above. */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

/** The prompt a run gets from its argument and stdin, per the rules above. */
export function combinePrompt(argPrompt: string, stdinText: string | undefined): string {
  const piped = stdinText?.trim();
  if (!piped) return argPrompt;
  return argPrompt.trim() ? `${argPrompt}\n\n${piped}` : piped;
}

export function schemaPrompt(answer: string, schema: unknown): string {
  return [
    'Turn this final answer into JSON that matches the JSON schema below. Use only what the answer says; do not invent values. Output the JSON only.',
    '',
    'Schema:',
    JSON.stringify(schema),
    '',
    'Answer:',
    answer,
  ].join('\n');
}
