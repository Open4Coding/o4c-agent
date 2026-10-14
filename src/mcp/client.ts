import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './serverConfig.js';
import type { McpCallResult, McpToolDescriptor } from './toolProxy.js';

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

export interface ConnectedServer {
  readonly config: McpServerConfig;
  readonly tools: readonly McpToolDescriptor[];
  callTool(toolName: string, input: Record<string, unknown>): Promise<McpCallResult>;
  /** Whatever the server wrote to stderr, newest last, capped. Empty for an http server. */
  stderrTail(): string;
  close(): Promise<void>;
}

function transportFor(server: McpServerConfig, onStderr: (chunk: string) => void): Transport {
  if (server.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: server.command as string,
      args: server.args ? [...server.args] : undefined,
      // `env` is passed through as given. Note the SDK's own behaviour here: with no `env` it
      // inherits a filtered-safe subset of the parent environment rather than the whole thing
      // (`getDefaultEnvironment`), which is the conservative default and is left alone.
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

  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { timeout: MCP_CONNECT_TIMEOUT_MS });
    const tools: McpToolDescriptor[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations,
    }));

    return {
      config: server,
      tools,
      callTool: (toolName, input) => client.callTool({ name: toolName, arguments: input }),
      stderrTail: () => stderr,
      close: async () => {
        try {
          await client.close();
        } catch {
          // Closing a connection that already died is not a failure worth propagating - the
          // caller is shutting down either way.
        }
      },
    };
  } catch (error) {
    // Do not leak the subprocess or socket when the handshake fails. Without this, a server that
    // starts but never answers would be left running after o4c gave up on it.
    await client.close().catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim();
    // The stderr tail is appended when there is one, because for a stdio server it is usually the
    // only thing that says WHY - "connection closed" on its own is almost never the real story,
    // and the child's own last words normally are (a missing module, a bad flag, no such command).
    throw new Error(detail ? `${reason} (server stderr: ${detail})` : reason, { cause: error });
  }
}
