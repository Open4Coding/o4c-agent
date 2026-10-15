import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './serverConfig.js';
import type { McpCallResult, McpToolDescriptor } from './toolProxy.js';
import type { McpPromptDescriptor, McpPromptResult } from './promptCommands.js';

/**
 * One MCP client connection, and the two transports behind it.
 *
 * This is the only file that touches the SDK. Everything above it works in terms of
 * `McpToolDescriptor`/`McpCallResult`, so the host layer and the tool proxy stay testable without
 * a subprocess, and a future SDK major (the local clone is already at `2.0.0-alpha.0` while
 * `1.32.1` is what is published and pinned here) lands in one place.
 */

/** What o4c calls itself when it introduces itself to a server. */
const CLIENT_INFO = { name: 'o4c-agent', version: '0.0.1' };

/**
 * How long a server gets to complete the MCP handshake plus its first `tools/list`.
 *
 * Shorter than the SDK's own 60s default (`DEFAULT_REQUEST_TIMEOUT_MSEC`) because this one is on
 * the startup path: a server that cannot introduce itself in ten seconds must not hold a session
 * closed. Tool calls keep the SDK default, since those are real work and a slow tool is not a
 * broken one.
 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/** How much of a server's stderr to keep for diagnostics. */
const STDERR_KEEP_CHARS = 4_000;

/**
 * How long a graceful close gets before the process is simply killed.
 *
 * The SDK's `close()` is willing to spend up to four seconds on one child (2s after closing its
 * stdin, then SIGTERM and 2s more - read in the installed `client/stdio.js`). That is a sensible
 * default for a program that is exiting; it is the wrong budget for o4c, which **reloads itself
 * into a fresh process after most turns** (`restartHandoff.ts`), so this runs per turn and any
 * wait here is a visible stall. A second is plenty for a healthy server to notice its stdin
 * closing; anything slower gets SIGKILL, which is no worse than what the SDK itself ends with.
 */
export const MCP_CLOSE_GRACE_MS = 1_000;

/** Resolves after `ms`, without holding the event loop open on its own. */
export function closeGraceTimer(ms: number = MCP_CLOSE_GRACE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export interface ConnectedServer {
  readonly config: McpServerConfig;
  readonly tools: readonly McpToolDescriptor[];
  /**
   * The server's prompts, or empty - which means any of three things, deliberately not
   * distinguished here: the server has none, it was not granted `slashCommands`, or listing
   * them failed (and then `promptProblem` says so).
   */
  readonly prompts: readonly McpPromptDescriptor[];
  /** Why `prompts` is empty when it should not have been. */
  readonly promptProblem?: string;
  callTool(toolName: string, input: Record<string, unknown>): Promise<McpCallResult>;
  /** Expands one prompt. Arguments are strings per the spec's own `GetPromptRequest`. */
  getPrompt(promptName: string, args: Record<string, string>): Promise<McpPromptResult>;
  /** Whatever the server wrote to stderr, newest last, capped. Empty for an http server. */
  stderrTail(): string;
  close(): Promise<void>;
  /**
   * Terminates a spawned server's process **synchronously**, with no graceful phase. A no-op for
   * an http server (nothing was spawned) and for one that has already exited.
   *
   * Exists for the two jobs `close()` cannot do. First, `process.on('exit')`, which permits no
   * asynchronous work at all - the same constraint that makes `UsageStore` write synchronously -
   * and is the only hook that catches every way this app leaves, the `process.exit()` calls on the
   * restart paths included. Second, as the fallback when a graceful close overruns its budget:
   * read in the installed SDK's own `close()`, it waits up to **2s** for the child to go after
   * closing its stdin and up to another **2s** after SIGTERM, so one wedged server could otherwise
   * stall a per-turn reload by four seconds.
   */
  killNow(): void;
}

/**
 * SIGKILLs a pid, swallowing the two normal races: the process already exited (ESRCH), or we are
 * not allowed to signal it. Nothing here is worth failing an exit path over.
 */
function killPid(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, or not ours to kill.
  }
}

function transportFor(server: McpServerConfig, onStderr: (chunk: string) => void): Transport {
  if (server.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: server.command as string,
      args: server.args ? [...server.args] : undefined,
      // `env` is passed through as given, and that is safe to do because of what the installed
      // SDK actually does with it: `start()` spawns with `{ ...getDefaultEnvironment(),
      // ...env }` - a filtered-safe subset of the parent environment (PATH, HOME/USERPROFILE,
      // SYSTEMROOT, TEMP and a few more; functions in values skipped) with the configured entries
      // layered on top. So a user adding one API key to a server's `env` does NOT lose PATH and
      // leave a `python`/`npx` server unable to start, which was the worry. Read in
      // `client/stdio.js`, not assumed from the docs, after a live run showed a server spawning
      // fine with PATH absent from its config. The whole parent environment is never passed.
      env: server.env ? { ...server.env } : undefined,
      cwd: server.cwd,
      // THE IMPORTANT ONE. The SDK's default is `"inherit"`, which sends the child's stderr
      // straight to o4c's own stderr - i.e. straight into the middle of a full-screen Ink frame.
      // This project has spent weeks on frame corruption from stray terminal writes
      // (see src/ui/resizeReflowFix.ts and docs/plans/0003), and an MCP server logging a warning
      // on startup would reintroduce it from outside our control. Piped and captured instead, so
      // it is available for diagnostics and can never reach the screen on its own.
      stderr: 'pipe',
    });
    // `stderr` is a PassThrough available immediately after construction, per the SDK's own
    // doc comment, so this can be attached before `connect()` and will not miss early output.
    transport.stderr?.on('data', (chunk: Buffer | string) => onStderr(String(chunk)));
    return transport;
  }
  return new StreamableHTTPClientTransport(new URL(server.url as string));
}

/**
 * Connects to one server and asks what tools it has.
 *
 * Throws on failure - deliberately, so the caller decides what a dead server means. The host layer
 * turns it into "this server's tools are unavailable" rather than letting it reach the session.
 */
export async function connectServer(server: McpServerConfig): Promise<ConnectedServer> {
  let stderr = '';
  const appendStderr = (chunk: string): void => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP_CHARS);
  };

  const client = new Client(CLIENT_INFO);
  const transport = transportFor(server, appendStderr);

  // Recorded rather than read on demand: the SDK's `pid` getter reads `this._process?.pid`, and
  // `close()` clears `_process` before it starts waiting - so by the time a graceful close has
  // overrun its budget and `killNow()` wants the pid, the getter has nothing left to give.
  let pid: number | undefined;

  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
    if (transport instanceof StdioClientTransport) pid = transport.pid ?? undefined;
    const listed = await client.listTools(undefined, { timeout: MCP_CONNECT_TIMEOUT_MS });
    const tools: McpToolDescriptor[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations,
    }));

    // Prompts are asked for only when the user granted this server `slashCommands` AND the
    // server said it has any. Both halves matter: without the grant this is work and surface
    // area nobody asked for (the default is off), and without the capability check it is a
    // request the spec says a server need not implement, which a strict one may answer with an
    // error - turning "no prompts" into "no server".
    let prompts: McpPromptDescriptor[] = [];
    let promptProblem: string | undefined;
    if (server.grants.slashCommands && client.getServerCapabilities()?.prompts) {
      try {
        const listedPrompts = await client.listPrompts(undefined, { timeout: MCP_CONNECT_TIMEOUT_MS });
        prompts = listedPrompts.prompts.map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          title: prompt.title,
          arguments: prompt.arguments,
        }));
      } catch (error) {
        // Caught, not propagated: a server whose prompts cannot be listed still has tools, and
        // losing those too would be a much bigger failure than the one that happened.
        promptProblem = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      config: server,
      tools,
      prompts,
      promptProblem,
      callTool: (toolName, input) => client.callTool({ name: toolName, arguments: input }),
      getPrompt: (promptName, args) => client.getPrompt({ name: promptName, arguments: args }),
      stderrTail: () => stderr,
      close: async () => {
        try {
          // Bounded, then killed. See MCP_CLOSE_GRACE_MS: the SDK's own close is willing to wait
          // four seconds, and this runs on the per-turn reload path.
          await Promise.race([client.close(), closeGraceTimer()]);
        } catch {
          // Closing a connection that already died is not a failure worth propagating - the
          // caller is shutting down either way.
        }
        killPid(pid);
      },
      killNow: () => killPid(pid),
    };
  } catch (error) {
    // Do not leak the subprocess or socket when the handshake fails. Without this, a server that
    // starts but never answers would be left running after o4c gave up on it. Read the pid first:
    // the handshake may well have failed *after* the child was spawned (the usual case - it
    // started and then never answered), and `close()` clears the field the getter reads.
    if (transport instanceof StdioClientTransport) pid = transport.pid ?? undefined;
    await Promise.race([client.close().catch(() => {}), closeGraceTimer()]);
    killPid(pid);
    const reason = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim();
    // The stderr tail is appended when there is one, because for a stdio server it is usually the
    // only thing that says WHY - "connection closed" on its own is almost never the real story,
    // and the child's own last words normally are (a missing module, a bad flag, no such command).
    throw new Error(detail ? `${reason} (server stderr: ${detail})` : reason, { cause: error });
  }
}
