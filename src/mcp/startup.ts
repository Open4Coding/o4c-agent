import type { Tool } from '../tools/types.js';
import { closeGraceTimer } from './client.js';
import { loadMcpServers } from './registry.js';
import { McpHost, type McpServerStatus } from './host.js';

/**
 * Starting MCP without making anyone wait for it.
 *
 * This is the whole of o4c's side of "wire MCP into startup": `cli.ts` calls `startMcpSession`
 * once and gets back a handle it can shut down. Keeping it here rather than inline in `cli.ts`
 * means the startup *policy* - what is read, when tools arrive, what the user is told, what
 * happens on the way out - is testable without a terminal, a provider or a render.
 */

export interface McpSessionOptions {
  /**
   * The trusted project root, or `undefined` for global config only.
   *
   * **Pass `undefined` for an untrusted project.** Project-scoped config is attacker-controlled
   * text from whoever's repo this is (the reasoning behind the trust gate in `cli.ts`), and an
   * MCP entry is not a preference - it is a command line o4c will spawn. `ConfigStore` is given
   * the same treatment for ordinary config, and this matters strictly more here.
   */
  readonly projectRoot: string | undefined;
  /** Air-gapped mode: refuse any server that would send bytes off this machine. */
  readonly secureMode?: boolean;
  /** Called once, with every ready server's tools, when discovery finishes. */
  readonly addTools: (tools: readonly Tool[]) => void;
  /** Test seams. Neither is overridden in production. */
  readonly load?: typeof loadMcpServers;
  readonly start?: typeof McpHost.start;
}

export interface McpSession {
  /**
   * Resolves when every configured server has connected or failed, with the notices worth showing
   * the user. Never rejects.
   *
   * Handed to `AgentLoop.registerPendingTools`, which waits on it at the start of the first turn
   * and emits the notices as warnings there.
   */
  readonly ready: Promise<readonly string[]>;
  /** One row per configured server, once `ready` has resolved; empty before that. */
  status(): readonly McpServerStatus[];
  /** Bounded, and safe to call more than once. */
  shutdown(): Promise<void>;
  /** Synchronous kill, for `process.on('exit')`. */
  killAllNow(): void;
}

function noticesFor(statuses: readonly McpServerStatus[]): string[] {
  const notices: string[] = [];
  for (const status of statuses) {
    if (status.state === 'failed') {
      // Named, with the reason, because the alternative is a user asking the model to use a tool
      // that silently is not there. `detail` already carries the server's own stderr tail when it
      // had one (see client.ts), which is usually the line that actually explains it.
      notices.push(`MCP server "${status.id}" could not be started, so its tools are unavailable: ${status.detail}`);
    } else if (status.state === 'blocked') {
      notices.push(`MCP server "${status.id}" was not started: ${status.detail}`);
    }
    // 'disabled' is the user's own setting, not news. 'ready' speaks for itself: its tools are
    // simply there.
  }
  return notices;
}

/**
 * Reads the config, connects every enabled server in the background, and returns immediately.
 *
 * Returns synchronously **on purpose**. Startup blocking on MCP is the failure this is shaped to
 * avoid: a single unreachable server would otherwise hold the first frame for the whole connect
 * timeout (10s, `MCP_CONNECT_TIMEOUT_MS`), and the user would be looking at a blank terminal
 * wondering whether o4c had hung - to launch a session that may not involve MCP at all.
 *
 * The cost of that choice is that tools can arrive after the UI does, which `addTools` plus
 * `AgentLoop.registerPendingTools` resolve between them: the screen is instant, and the first
 * turn waits only if the user gets there first.
 */
export function startMcpSession(options: McpSessionOptions): McpSession {
  const load = options.load ?? loadMcpServers;
  const start = options.start ?? McpHost.start;

  let host: McpHost | undefined;
  let statuses: readonly McpServerStatus[] = [];

  const ready = (async (): Promise<readonly string[]> => {
    const { servers, problems } = await load(options.projectRoot);
    // Nothing configured is the common case and must cost nothing: no host, no timers, no
    // process.on handlers at the call site, and - the point - no behaviour change at all for a
    // user who has never set up an MCP server. The config problems are still reported, since a
    // typo that produced no servers is exactly when the user needs telling.
    if (servers.length === 0) return [...problems];

    host = await start(servers, { secureMode: options.secureMode });
    statuses = host.status();
    options.addTools(host.tools());
    return [...problems, ...noticesFor(statuses)];
  })().catch((error: unknown) => [
    // `McpHost.start` collects per-server failures rather than throwing, and `loadMcpServers`
    // turns unreadable config into a problem string, so reaching here means something unforeseen.
    // It still must not take the session down: no MCP is a worse session, not a dead one.
    `MCP could not be started: ${error instanceof Error ? error.message : String(error)}`,
  ]);

  return {
    ready,
    status: () => statuses,
    shutdown: async () => {
      // Waited on, so a shutdown racing a still-connecting server does not leave the host - and
      // its subprocesses - created a moment after we stopped looking. Bounded, because on this
      // path the user has asked to leave: a server still inside its 10s connect timeout must not
      // turn /exit into a ten-second pause. If the race is lost there is no host to close yet,
      // and the connect in flight is the one case this layer cannot reap - but its child gets
      // EOF on stdin the moment this process's pipes close, which is the same signal the SDK's
      // own graceful close uses, so a well-behaved server still exits on its own.
      await Promise.race([ready, closeGraceTimer()]);
      await host?.shutdown();
    },
    killAllNow: () => host?.killAllNow(),
  };
}
