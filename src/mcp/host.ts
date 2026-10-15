import type { Tool } from '../tools/types.js';
import { lifecycleOf, reachOf, type McpReach, type McpServerConfig } from './serverConfig.js';
import { closeGraceTimer, connectServer, MCP_CLOSE_GRACE_MS, type ConnectedServer } from './client.js';
import { proxyTools } from './toolProxy.js';
import type { McpPromptResult, McpPromptSource } from './promptCommands.js';

/**
 * The MCP host: o4c's side of "one host, N clients, one client per server".
 *
 * Owns connecting, the tool list the loop ends up with, and shutdown. Deliberately knows nothing
 * about MCP's wire protocol (that is `client.ts`) or about how a result becomes a string (that is
 * `toolProxy.ts`), so what is tested here is the behaviour that matters operationally: a broken
 * server costs you that server and nothing else.
 */

export type McpServerState = 'ready' | 'failed' | 'disabled' | 'blocked';

export interface McpServerStatus {
  readonly id: string;
  readonly state: McpServerState;
  readonly lifecycle: 'spawn' | 'attach';
  readonly reach: McpReach;
  /** Tool count when ready; 0 otherwise. */
  readonly toolCount: number;
  /** Why, for `failed`, `disabled` and `blocked`. */
  readonly detail?: string;
}

export interface McpHostOptions {
  /**
   * Secure/air-gapped mode. When set, servers that would send anything off the machine are
   * refused rather than connected - `PATH_FORWARD.md` §1a's zero-egress requirement.
   *
   * Classified by `reachOf`, i.e. by **egress rather than transport**: a spawned subprocess and a
   * loopback HTTP application are both local, which is the correction the Blender case forces on
   * §1a's current stdio-versus-HTTP shorthand.
   */
  readonly secureMode?: boolean;
  /** Swapped out in tests so nothing is spawned. */
  readonly connect?: (server: McpServerConfig) => Promise<ConnectedServer>;
}

/**
 * Connects every enabled server, collecting failures instead of propagating them.
 *
 * Servers are connected **concurrently**, because this sits on the startup path and N servers
 * must not cost N handshakes in series. `MCP_CONNECT_TIMEOUT_MS` bounds the slowest one, so the
 * whole step is bounded by one timeout rather than their sum.
 */
export class McpHost {
  private connections: ConnectedServer[] = [];
  private statuses: McpServerStatus[] = [];
  private proxied: Tool[] = [];

  private constructor() {}

  static async start(
    servers: readonly McpServerConfig[],
    options: McpHostOptions = {},
  ): Promise<McpHost> {
    const host = new McpHost();
    const connect = options.connect ?? connectServer;

    const outcomes = await Promise.all(
      servers.map(async (server): Promise<{ status: McpServerStatus; connection?: ConnectedServer; tools?: Tool[] }> => {
        const base = { id: server.id, lifecycle: lifecycleOf(server), reach: reachOf(server), toolCount: 0 } as const;

        if (!server.enabled) {
          return { status: { ...base, state: 'disabled', detail: 'Turned off in config.' } };
        }
        if (options.secureMode && reachOf(server) === 'remote') {
          return {
            status: {
              ...base,
              state: 'blocked',
              detail: 'Secure mode allows only servers reachable without leaving this machine; this one is remote.',
            },
          };
        }

        try {
          const connection = await connect(server);
          const tools = proxyTools(server, connection.tools, (toolName, input) => connection.callTool(toolName, input));
          return { status: { ...base, state: 'ready', toolCount: tools.length }, connection, tools };
        } catch (error) {
          // The whole point of this class. A server that will not start, or starts and never
          // answers, costs its own tools and nothing else - the session stays usable, exactly as
          // a dead local model server does rather than taking the app down with it.
          return {
            status: { ...base, state: 'failed', detail: error instanceof Error ? error.message : String(error) },
          };
        }
      }),
    );

    host.statuses = outcomes.map((o) => o.status);
    host.connections = outcomes.flatMap((o) => (o.connection ? [o.connection] : []));
    host.proxied = outcomes.flatMap((o) => o.tools ?? []);
    return host;
  }

  /** Every ready server's tools, namespaced, ready to append to `defaultTools`. */
  tools(): readonly Tool[] {
    return this.proxied;
  }

  /** One row per configured server, including the ones that are not running and why. */
  status(): readonly McpServerStatus[] {
    return this.statuses;
  }

  /** Whatever a spawned server wrote to stderr, for diagnostics. */
  stderrTail(serverId: string): string {
    return this.connections.find((c) => c.config.id === serverId)?.stderrTail() ?? '';
  }

  /**
   * Every granted server's prompts, for `buildPromptCommands`.
   *
   * The grant is already applied in `client.ts` (an ungranted server is never asked), so this
   * filters on nothing: a server with no prompts simply contributes none. Kept as a method
   * rather than resolved into commands here because turning prompts into command rows is
   * startup *policy* - it needs the built-in name list to check against - and this class is
   * deliberately the layer that knows only about connections.
   */
  promptSources(): readonly McpPromptSource[] {
    return this.connections
      .filter((c) => c.prompts.length > 0)
      .map((c) => ({ config: c.config, prompts: c.prompts }));
  }

  /** One notice per server whose prompts could not be listed, phrased like the rest: named,
   * with the reason, and clear that only the prompts are missing. */
  promptProblems(): readonly string[] {
    return this.connections.flatMap((c) =>
      c.promptProblem
        ? [`MCP server "${c.config.id}" is granted slashCommands but its prompts could not be listed, so it adds no commands (its tools are unaffected): ${c.promptProblem}`]
        : [],
    );
  }

  /**
   * Expands one prompt on one server.
   *
   * Throws for an unknown server rather than returning empty: the only caller resolves the
   * server id from a command row this host produced, so a miss means the session reloaded and
   * the rows outlived the connection - which the user needs told, not silently given nothing.
   */
  async getPrompt(serverId: string, promptName: string, args: Record<string, string>): Promise<McpPromptResult> {
    const connection = this.connections.find((c) => c.config.id === serverId);
    if (!connection) throw new Error(`MCP server "${serverId}" is not connected.`);
    return connection.getPrompt(promptName, args);
  }

  /**
   * Closes every connection, which also terminates the subprocesses o4c spawned.
   *
   * Never throws: this runs on the way out, and a connection that already died must not stop the
   * others from being closed. Note o4c reloads itself into a fresh process after most turns (see
   * `docs/plans` item 22 / `restartHandoff.ts`), so for a spawned server this runs often, not just
   * at exit - which is the reason it has to be cheap and silent.
   */
  async shutdown(): Promise<void> {
    const closing = this.connections;
    this.connections = [];
    this.proxied = [];
    // `allSettled`, not `all`: `all` rejects on the FIRST failure, which would abandon every
    // connection after it and leak exactly the subprocesses this is here to reap. `connectServer`
    // happens to swallow its own close errors, but shutdown must not depend on that - a transport
    // that throws on close is the normal consequence of a server having already died.
    //
    // Bounded as a whole on top of each connection's own bound, then killed: a server that will
    // not close must not hold up the reload the user is waiting on. `killNow()` is synchronous and
    // idempotent, so running it across everything afterwards costs nothing for the connections
    // that closed properly.
    await Promise.race([
      Promise.allSettled(closing.map((c) => c.close())),
      closeGraceTimer(MCP_CLOSE_GRACE_MS * 2),
    ]);
    for (const connection of closing) connection.killNow();
  }

  /**
   * Kills every spawned server **synchronously**, for `process.on('exit')`.
   *
   * That hook permits no asynchronous work, so `shutdown()` cannot run there - and it is the only
   * hook that catches every way this app leaves, the `process.exit()` calls on the restart paths
   * included (`cli.ts` installs the same backstop for `UsageStore`, for the same reason). Without
   * it a reload chain would orphan one subprocess per server per turn: a child is not killed by
   * its parent exiting, on either platform.
   */
  killAllNow(): void {
    for (const connection of this.connections) connection.killNow();
  }
}
