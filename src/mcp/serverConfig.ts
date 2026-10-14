/**
 * MCP server definitions: the config shape, its validation, and the two classifications the rest
 * of the host layer needs from it (lifecycle, and whether a server is reachable without egress).
 *
 * Checklist item 21, design doc §5. Everything here is pure - no spawning, no sockets, no SDK -
 * so the rules that actually matter for safety can be asserted directly rather than through a
 * live subprocess.
 *
 * **"Plugin" is not a separate mechanism.** In MCP's own terms o4c is a *host* running one
 * *client* per *server*, and a plugin and an external application like Blender are both just
 * servers. Two mechanisms would mean two approval paths and two lifecycle managers - two places
 * to get isolation wrong - so there is one host layer, and a server's config entry carries the
 * differences: how it is reached (`transport`), and what it is allowed (`grants`).
 */

/** Where a server's definition came from, for `/mcp`-style listings and error messages. */
export type McpTransport = 'stdio' | 'http';

/**
 * Whether o4c starts and owns this server's process, or connects to something already running.
 *
 * **Derived from the transport, never configured separately**, because the spec leaves no choice:
 * `specification/2026-07-28/basic/transports/stdio.mdx` opens with "In the stdio transport, the
 * client launches the MCP server as a subprocess", and there is no way to attach to a process
 * someone else already owns over stdio - you cannot take over its stdin. Streamable HTTP is the
 * mirror image: the server runs independently and the client POSTs to its endpoint.
 *
 * This is the correction the external-application cases force on design doc §5.4, which borrowed
 * `pi-acp`'s "1 session <-> 1 spawned subprocess" shape. That is right for a plugin, whose
 * lifetime o4c owns, and wrong for Blender - o4c must not launch and own a long-running GUI
 * application the user already has open. Two separate config fields could contradict each other
 * ("attach over stdio" is not a thing), so one field decides and the other is computed.
 */
export type McpLifecycle = 'spawn' | 'attach';

/**
 * Whether reaching this server sends anything off the machine - the real criterion for
 * `PATH_FORWARD.md` §1a's secure/air-gapped mode.
 *
 * §1a currently simplifies this to "stdio/local is secure mode, HTTP/remote is connected-mode
 * only", and the Blender case breaks that: an application reached over **loopback** HTTP has
 * exactly as much egress as a spawned subprocess, namely none, so barring it from secure mode
 * would be wrong on §1a's own terms. What matters is egress, not transport.
 */
export type McpReach = 'local' | 'remote';

/** What a server is permitted beyond "the model may call its tools". Every one defaults to
 * false: a server gets nothing it was not explicitly given. */
export interface McpGrants {
  /**
   * Whether this server's tools also appear as `/`-invokable commands, through the
   * `commands.json` contract of §5.5.
   *
   * This is design doc §5.6's open question - "does an MCP server's exposed tools automatically
   * become `/`-invokable commands, or stay purely LLM-invoked" - answered as a per-server flag
   * rather than one global rule, because both answers are right for different servers: a
   * project's own plan-store plugin wants to be driveable by hand, and a 40-tool browser
   * automation server would bury the palette. Default off, which is also standard MCP usage.
   */
  slashCommands?: boolean;
  /**
   * Whether this server may be granted the §5.5 resource contract - its own namespaced config,
   * `.o4c/data/<id>/`, and a log stream. A plugin needs this; an external application o4c merely
   * talks to does not, and handing it a writable directory for no reason is pure downside.
   */
  resources?: boolean;
  /**
   * Whether this server's `readOnlyHint` tool annotations may be believed.
   *
   * **Off by default, and this one is load-bearing.** MCP tools carry `ToolAnnotations`
   * (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and the obvious move
   * is to map `readOnlyHint` onto `Tool.mutating`. The spec forbids it in as many words
   * (`specification/2026-07-28/schema.mdx`): "all properties in ToolAnnotations are **hints** ...
   * should not be relied upon for security decisions ... received from untrusted servers."
   *
   * The consequence here is concrete rather than theoretical. `classifyToolAccess`
   * (`src/ui/modePolicy.ts`) opens with `if (!tool.mutating) return 'allow'` - non-mutating means
   * allowed unconditionally, in every mode, **including Plan**, with no confirmation. So trusting
   * `readOnlyHint` would let any server declare its own tools read-only and execute freely in the
   * mode whose entire purpose is being read-only: the sandboxed thing handing over the bypass.
   *
   * So the hints are *displayed* as the server's own claim and never decide anything, unless the
   * user turns this on for a specific server - which is the user asserting it, not the server.
   */
  trustReadOnlyHints?: boolean;
}

/** One validated server definition. */
export interface McpServerConfig {
  /** The key this entry had in `servers`, and the namespace its tools are exposed under. */
  readonly id: string;
  readonly transport: McpTransport;
  readonly enabled: boolean;
  readonly grants: Required<McpGrants>;
  /** stdio only: the executable o4c spawns, plus how. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** http only: the endpoint o4c POSTs to. */
  readonly url?: string;
}

export interface ParsedServers {
  readonly servers: readonly McpServerConfig[];
  /**
   * One message per rejected entry, for the UI to surface.
   *
   * Collected rather than thrown on purpose: a typo in one server definition must not stop o4c
   * from starting, or from using the other servers. The same reasoning as `src/ui/App.tsx`'s
   * treatment of a dead local server - degrade to "this one is unavailable", never take the
   * session down with it.
   */
  readonly problems: readonly string[];
}

/**
 * Server ids become part of a tool name as `mcp__<id>__<tool>`, so the id has to be unambiguous
 * inside that encoding - hence no `__` of its own - and has to stay a plain identifier, since it
 * is also a directory name under `.o4c/data/` when `grants.resources` is set.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrants(raw: unknown, id: string, problems: string[]): Required<McpGrants> {
  const grants: Required<McpGrants> = { slashCommands: false, resources: false, trustReadOnlyHints: false };
  if (raw === undefined) return grants;
  if (!isPlainObject(raw)) {
    problems.push(`MCP server "${id}": "grants" must be an object; ignoring it and granting nothing.`);
    return grants;
  }
  for (const key of ['slashCommands', 'resources', 'trustReadOnlyHints'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      problems.push(`MCP server "${id}": "grants.${key}" must be true or false, not ${typeof value}; treating it as false.`);
      continue;
    }
    grants[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'slashCommands' && key !== 'resources' && key !== 'trustReadOnlyHints') {
      problems.push(`MCP server "${id}": unknown grant "${key}" - ignored. A misspelled grant must never read as granted.`);
    }
  }
  return grants;
}

function parseStringRecord(raw: unknown, id: string, field: string, problems: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    problems.push(`MCP server "${id}": "${field}" must be an object of strings; ignoring it.`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      problems.push(`MCP server "${id}": "${field}.${key}" must be a string; ignoring that one.`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function parseOne(id: string, raw: unknown, problems: string[]): McpServerConfig | undefined {
  if (!ID_PATTERN.test(id)) {
    problems.push(
      `MCP server "${id}": id must be lower-case letters, digits, "-" or "_", starting with a letter or digit. ` +
        'It becomes part of a tool name and a directory name, so it cannot be arbitrary text.',
    );
    return undefined;
  }
  if (id.includes('__')) {
    problems.push(`MCP server "${id}": id must not contain "__" - tool names are namespaced as mcp__<id>__<tool>, so that would be ambiguous.`);
    return undefined;
  }
  if (!isPlainObject(raw)) {
    problems.push(`MCP server "${id}": definition must be an object.`);
    return undefined;
  }

  const transport = raw.transport;
  if (transport !== 'stdio' && transport !== 'http') {
    problems.push(`MCP server "${id}": "transport" must be "stdio" (o4c spawns it) or "http" (o4c connects to it), not ${JSON.stringify(transport)}.`);
    return undefined;
  }

  const enabledRaw = raw.enabled;
  if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
    problems.push(`MCP server "${id}": "enabled" must be true or false; treating it as disabled, since an unreadable setting is not consent to run.`);
    return undefined;
  }
  const enabled = enabledRaw ?? true;
  const grants = parseGrants(raw.grants, id, problems);

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      problems.push(`MCP server "${id}": a stdio server needs a "command" to spawn.`);
      return undefined;
    }
    let args: string[] | undefined;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        problems.push(`MCP server "${id}": "args" must be an array of strings.`);
        return undefined;
      }
      args = raw.args as string[];
    }
    const cwd = raw.cwd;
    if (cwd !== undefined && typeof cwd !== 'string') {
      problems.push(`MCP server "${id}": "cwd" must be a string.`);
      return undefined;
    }
    return {
      id,
      transport,
      enabled,
      grants,
      command: raw.command,
      args,
      env: parseStringRecord(raw.env, id, 'env', problems),
      cwd,
    };
  }

  if (typeof raw.url !== 'string' || raw.url.trim() === '') {
    problems.push(`MCP server "${id}": an http server needs a "url" to connect to.`);
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.url);
  } catch {
    problems.push(`MCP server "${id}": "url" is not a valid URL: ${JSON.stringify(raw.url)}.`);
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    problems.push(`MCP server "${id}": "url" must be http: or https:, not ${parsed.protocol} - MCP's remote transport is Streamable HTTP.`);
    return undefined;
  }
  return { id, transport, enabled, grants, url: raw.url };
}

/**
 * Validates the `servers` map out of the merged MCP config, returning what is usable and a
 * message for everything that is not.
 *
 * The input is whatever `ConfigStore`'s 3-tier `resolve()` produced for the `['mcp']` namespace,
 * so entries have already been merged global -> local -> personal key-by-key (see
 * `jsonMerge.ts`): a project can override just the `url` of a globally-defined server without
 * restating the rest of it, and arrays like `args` replace wholesale rather than concatenating.
 */
export function parseServers(raw: unknown): ParsedServers {
  const problems: string[] = [];
  if (raw === undefined) return { servers: [], problems };
  if (!isPlainObject(raw)) {
    return { servers: [], problems: ['MCP config: "servers" must be an object keyed by server id.'] };
  }
  const servers: McpServerConfig[] = [];
  for (const [id, definition] of Object.entries(raw)) {
    const parsed = parseOne(id, definition, problems);
    if (parsed) servers.push(parsed);
  }
  return { servers, problems };
}

/** See `McpLifecycle` - fully determined by the transport, by the spec's own definition. */
export function lifecycleOf(server: McpServerConfig): McpLifecycle {
  return server.transport === 'stdio' ? 'spawn' : 'attach';
}

/**
 * Hostnames that mean "this machine". `URL` normalises IPv6 to bracketed lower-case form, and
 * `127.0.0.0/8` is loopback in its entirety, not just `127.0.0.1`.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1' || host === '[::ffff:127.0.0.1]') return true;
  // Matching the /8 numerically rather than by prefix string, so "127.0.0.1.example.com" cannot
  // pass by looking like it starts with 127.
  const octets = host.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return false;
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((n) => n <= 255);
}

/**
 * Whether reaching this server stays on the machine. A spawned subprocess always does; an http
 * server does only when its host is loopback.
 *
 * This is what a secure/air-gapped-mode gate should consult, in place of §1a's current
 * stdio-versus-HTTP shorthand. Note what it deliberately does NOT do: it says nothing about where
 * the server itself then sends things. A loopback MCP server is free to call out to the internet,
 * and no amount of config inspection can see that - this classifies o4c's own egress, which is
 * the only thing o4c can actually know.
 */
export function reachOf(server: McpServerConfig): McpReach {
  if (server.transport === 'stdio') return 'local';
  try {
    return isLoopbackHost(new URL(server.url ?? '').hostname) ? 'local' : 'remote';
  } catch {
    // parseServers rejects an unparseable url, so this is unreachable through it; "remote" is
    // still the right answer for anything that got here another way - the cautious one.
    return 'remote';
  }
}

/** The tool-name namespace for a server, per the `mcp__<id>__<tool>` convention. */
export function toolNamespace(serverId: string): string {
  return `mcp__${serverId}__`;
}
