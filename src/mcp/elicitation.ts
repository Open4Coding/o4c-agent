/**
 * MCP elicitation (plan 0006 G7): a server asking the USER for something mid-call - a form of a few
 * fields, or (URL mode) a page to visit, such as a sign-in. o4c always asks first whether to answer
 * at all, then asks one field at a time through the same dialog `ask_user` uses. With nobody to ask
 * (a headless run), the answer is "decline". Nothing the server sends is shown as anything but the
 * server's own request, named as coming from it.
 */
export type Ask = (question: string, options: string[]) => Promise<string | undefined>;

export interface ElicitParams {
  mode?: 'form' | 'url';
  message: string;
  url?: string;
  requestedSchema?: {
    properties?: Record<string, { type?: string; title?: string; description?: string; enum?: unknown[]; default?: unknown }>;
    required?: string[];
  };
}

export type ElicitResult = { action: 'accept'; content?: Record<string, string | number | boolean> } | { action: 'decline' } | { action: 'cancel' };

const ANSWER = 'Answer it';
const DECLINE = 'Decline';

export async function elicit(serverId: string, params: ElicitParams, ask: Ask | undefined): Promise<ElicitResult> {
  if (!ask) return { action: 'decline' };
  if (params.mode === 'url' || params.url) {
    const done = 'I have done it';
    const choice = await ask(`The MCP server "${serverId}" asks you to open this page:\n${params.url ?? '(no URL given)'}\n${params.message}`, [done, DECLINE]);
    if (choice === undefined) return { action: 'cancel' };
    return choice === done ? { action: 'accept' } : { action: 'decline' };
  }
  const consent = await ask(`The MCP server "${serverId}" asks for information:\n${params.message}`, [ANSWER, DECLINE]);
  if (consent === undefined) return { action: 'cancel' };
  if (consent !== ANSWER) return { action: 'decline' };
  const content: Record<string, string | number | boolean> = {};
  const props = params.requestedSchema?.properties ?? {};
  const required = new Set(params.requestedSchema?.required ?? []);
  for (const [name, field] of Object.entries(props)) {
    const label = `${field.title ?? name}${field.description ? ` - ${field.description}` : ''}${required.has(name) ? '' : ' (optional - empty to skip)'}`;
    const options =
      field.type === 'boolean' ? ['yes', 'no'] : Array.isArray(field.enum) ? field.enum.map(String) : [];
    const answer = await ask(`"${serverId}" - ${label}`, options);
    if (answer === undefined) return { action: 'cancel' };
    const text = answer.trim();
    if (!text) {
      if (required.has(name)) return { action: 'decline' };
      continue;
    }
    if (field.type === 'boolean') content[name] = /^(y|yes|true|1)$/i.test(text);
    else if (field.type === 'number' || field.type === 'integer') {
      const n = Number(text);
      if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) return { action: 'decline' };
      content[name] = n;
    } else content[name] = text;
  }
  return { action: 'accept', content };
}

/** `${VAR}` in a header value, filled from the environment when connecting - tokens stay out of config. */
export function expandHeaders(headers: Readonly<Record<string, string>> | undefined, env: NodeJS.ProcessEnv = process.env): { headers: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = env[name];
      if (value === undefined) missing.push(name);
      return value ?? '';
    });
  }
  return { headers: out, missing };
}
