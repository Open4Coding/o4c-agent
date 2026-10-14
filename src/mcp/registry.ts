import { ConfigStore, defaultGlobalConfigDir } from '../session/configStore.js';
import { parseServers, type ParsedServers } from './serverConfig.js';

/**
 * Where MCP server definitions live: `config.json` inside the `mcp` namespace, i.e.
 * `~/.o4c/mcp/config.json`, `<project>/.o4c/mcp/config.json`, and
 * `<project>/.o4c/mcp/config.local.json`.
 *
 * Deliberately `ConfigStore` with a namespace rather than a new `servers.json` and a loader of its
 * own. §5.5 built the namespace parameter for exactly this - "reads/writes under that subdirectory
 * at every scope, reusing the exact same tiering/merge logic as core config rather than a parallel
 * class" - and a second file format would mean a second merge implementation to keep in step, for
 * no gain. It also means server definitions get the three scopes for free, which is what the
 * cases this feature exists for actually need: a machine-wide Blender entry in global, a
 * project's own plugin in local (shareable, committed), and an API-keyed remote server in
 * personal (gitignored).
 */
export const MCP_CONFIG_NAMESPACE = ['mcp'];

/** The key the server map lives under inside that file. */
export const MCP_SERVERS_KEY = 'servers';

export function mcpConfigStore(projectRoot: string | undefined, globalDir: string = defaultGlobalConfigDir()): ConfigStore {
  return new ConfigStore(projectRoot, globalDir, MCP_CONFIG_NAMESPACE);
}

/**
 * Reads and validates every configured MCP server, merged across the three scopes.
 *
 * Returns problems rather than throwing, and returns them even when some servers parsed fine, so
 * startup can carry on with what works and still tell the user what it ignored. Nothing here
 * spawns or connects to anything - that is the lifecycle layer's job; this only answers "what is
 * configured, and what is wrong with it".
 */
export async function loadMcpServers(
  projectRoot: string | undefined,
  globalDir: string = defaultGlobalConfigDir(),
): Promise<ParsedServers> {
  let resolved: Record<string, unknown>;
  try {
    resolved = await mcpConfigStore(projectRoot, globalDir).resolve();
  } catch (error) {
    // Malformed JSON in any of the three files. `ConfigStore.resolve()` lets the SyntaxError out,
    // and o4c must still start - an unparseable MCP config means "no MCP servers today", not "no
    // o4c today".
    const message = error instanceof Error ? error.message : String(error);
    return { servers: [], problems: [`MCP config could not be read, so no MCP servers were loaded: ${message}`] };
  }
  return parseServers(resolved[MCP_SERVERS_KEY]);
}
