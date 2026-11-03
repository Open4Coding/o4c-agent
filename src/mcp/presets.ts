/**
 * `/mcp add <preset>` (plan 0006 G8): a few well-known servers, ready to add to config without
 * writing JSON by hand. Each is the reference server's published package, run on demand with
 * `npx`/`uvx`; o4c installs nothing itself. The entry lands in this project's config (or global,
 * outside a project) and starts with the next process.
 */
export interface McpPreset {
  name: string;
  description: string;
  entry: (cwd: string) => Record<string, unknown>;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    name: 'filesystem',
    description: 'Read and write files under this folder (Node, npx).',
    entry: (cwd) => ({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', cwd] }),
  },
  {
    name: 'git',
    description: 'Git history, diffs and commits for this repository (Python, uvx).',
    entry: (cwd) => ({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', cwd] }),
  },
  {
    name: 'memory',
    description: 'A small knowledge-graph memory the model can write to and query (Node, npx).',
    entry: () => ({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }),
  },
  {
    name: 'sequential-thinking',
    description: 'A structured step-by-step thinking tool (Node, npx).',
    entry: () => ({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }),
  },
  {
    name: 'time',
    description: 'Current time and time-zone conversion (Python, uvx).',
    entry: () => ({ transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] }),
  },
  {
    name: 'fetch',
    description: 'Fetches web pages as markdown - goes out to the internet (Python, uvx).',
    entry: () => ({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }),
  },
];

export function describePresets(): string[] {
  return ['MCP presets - /mcp add <name>:', ...MCP_PRESETS.map((p) => `  ${p.name.padEnd(20)} ${p.description}`)];
}

/** `@server:resource` in a message: each one found, as server id and the URI or name after it. */
export function resourceMentions(text: string, serverIds: ReadonlySet<string>): { token: string; serverId: string; ref: string }[] {
  const out: { token: string; serverId: string; ref: string }[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_-]+):(\S+)/g)) {
    if (serverIds.has(m[1]!)) out.push({ token: `@${m[1]}:${m[2]}`, serverId: m[1]!, ref: m[2]! });
  }
  return out;
}
