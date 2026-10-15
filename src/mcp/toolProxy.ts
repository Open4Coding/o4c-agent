import type { McpToolProvenance, Tool } from '../tools/types.js';
import { reachOf, toolNamespace, type McpServerConfig } from './serverConfig.js';

/**
 * Turning an MCP server's tools into `Tool`s the agent loop can call.
 *
 * Everything here is pure except the injected `call`, so the rules that matter - how a result
 * becomes a string, and what `mutating` ends up as - are assertable without spawning anything.
 */

/**
 * The parts of an MCP tool descriptor this layer uses.
 *
 * Declared locally rather than imported from the SDK on purpose: the SDK's own type is the deep
 * structural type zod infers from `ListToolsResultSchema`, which is awkward to name and would tie
 * our `Tool` construction to its exact shape. These fields were read off the installed
 * `1.32.1` typings (`client/index.d.ts`'s `listTools()` return) rather than assumed, and a
 * narrower local interface is also what lets the tests build descriptors by hand.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * The shape of `client.callTool()`'s result that this layer reads.
 *
 * `toolResult` is not a typo or a convenience: the SDK's `callTool` return type is a **union** of
 * the modern `{ content, isError }` result and MCP's legacy `{ toolResult }` one
 * (`CompatibilityCallToolResultSchema` = `CallToolResultSchema.or(ResultSchema.extend({
 * toolResult: z.unknown() }))`), which dates from the 2024-11-05 revision. Found by the
 * typechecker when the narrower interface refused to accept the real return type - without it
 * `flattenToolResult` would have quietly reported "no content" for any server still speaking the
 * old shape, which is the worst available outcome: a result that silently vanishes.
 */
export interface McpCallResult {
  content?: unknown;
  isError?: unknown;
  toolResult?: unknown;
}

/** How a proxied tool reaches its server. Injected so tests need no subprocess. */
export type McpToolCaller = (toolName: string, input: Record<string, unknown>) => Promise<McpCallResult>;

/** `mcp__<server>__<tool>`, per the `toolNamespace` convention. */
export function mcpToolName(serverId: string, toolName: string): string {
  return toolNamespace(serverId) + toolName;
}

/** Recovers the server-side tool name from a proxied one. */
export function originalToolName(serverId: string, proxiedName: string): string {
  const prefix = toolNamespace(serverId);
  return proxiedName.startsWith(prefix) ? proxiedName.slice(prefix.length) : proxiedName;
}

/**
 * Whether a proxied tool counts as mutating for `classifyToolAccess`.
 *
 * **Default true, and only the user can lower it.** MCP's `readOnlyHint` is the obvious input
 * here and the spec rules it out in as many words (`specification/2026-07-28/schema.mdx`): "all
 * properties in ToolAnnotations are **hints** ... should not be relied upon for security
 * decisions ... received from untrusted servers."
 *
 * What makes that concrete rather than pedantic: `classifyToolAccess` (`src/ui/modePolicy.ts`)
 * opens with `if (!tool.mutating) return 'allow'`, so non-mutating means allowed unconditionally
 * in every mode, **Plan included**. A server trusted to describe itself could therefore run
 * without confirmation in the mode whose entire purpose is being read-only - the sandboxed thing
 * handing over the key.
 *
 * So the hint is honoured only when the user has set `grants.trustReadOnlyHints` for that
 * specific server, which is the user's assertion about a server they chose, not the server's
 * assertion about itself.
 */
export function isMutating(server: McpServerConfig, descriptor: McpToolDescriptor): boolean {
  if (!server.grants.trustReadOnlyHints) return true;
  return descriptor.annotations?.readOnlyHint !== true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bytes behind a base64 payload, for the placeholders below. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * One content block as text.
 *
 * Non-text blocks become a short description instead of their payload, and that is a deliberate
 * choice rather than a limitation to apologise for. A base64 image inlined here would be
 * megabytes of unreadable text: `AgentLoop.boundToolOutput` would then truncate it (see below),
 * so the model would receive *half a base64 blob* - useless to it, while still having spent the
 * entire tool-result budget for that turn. A sentence saying what came back is strictly more
 * informative and costs almost nothing. If o4c later grows a path for image tool results, this is
 * the single function that has to change.
 */
function blockToText(block: unknown): string {
  if (!isRecord(block)) return '';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
    case 'audio': {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'unknown type';
      const bytes = typeof block.data === 'string' ? base64Bytes(block.data) : 0;
      return `[${String(block.type)} returned by the tool: ${mime}, ${bytes.toLocaleString()} bytes. o4c does not pass ${String(block.type)} tool results to the model, so it is not included here.]`;
    }
    case 'resource': {
      // An embedded resource carries either inline `text` or base64 `blob`. Inline text is real
      // content the model should see; a blob gets the same treatment as an image.
      const resource = isRecord(block.resource) ? block.resource : undefined;
      if (resource && typeof resource.text === 'string') return resource.text;
      const uri = resource && typeof resource.uri === 'string' ? resource.uri : 'unknown uri';
      const mime = resource && typeof resource.mimeType === 'string' ? resource.mimeType : 'unknown type';
      const bytes = resource && typeof resource.blob === 'string' ? base64Bytes(resource.blob) : 0;
      return `[binary resource returned by the tool: ${uri} (${mime}, ${bytes.toLocaleString()} bytes). Not included here.]`;
    }
    case 'resource_link': {
      const uri = typeof block.uri === 'string' ? block.uri : 'unknown uri';
      const name = typeof block.name === 'string' ? ` (${block.name})` : '';
      return `[resource link: ${uri}${name}]`;
    }
    default:
      // An unknown block type is a newer spec revision than this build knows, not a bug. Say so
      // rather than dropping it silently, so the gap is visible in the transcript.
      return `[unsupported MCP content block of type "${String(block.type)}" - this o4c build does not render it.]`;
  }
}

/**
 * The string a proxied tool returns to the loop.
 *
 * Not length-bounded here, and that is correct rather than an oversight:
 * `AgentLoop.boundToolOutput` is applied at "the single call site every tool result passes
 * through" (`src/agent/loop.ts`) and its own comment commits to covering "every future tool...
 * without any of them having to remember". Capping again here would risk double-truncation and a
 * marker that contradicts the real one. The pre-bound a built-in tool does cheaply (`run_shell`'s
 * `maxBuffer`) has no equivalent here either: by the time this runs the SDK has already parsed the
 * whole JSON-RPC response into memory, so there is no allocation left to avoid.
 *
 * `isError` is surfaced as a prefixed string rather than a thrown error, matching what the
 * built-in tools do (`read_file` "still reports a missing file as an error string") - a tool
 * failure is information for the model, not a reason to end the turn.
 */
export function flattenToolResult(result: McpCallResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map(blockToText)
    .filter((part) => part !== '')
    .join('\n');

  let body: string;
  if (text !== '') {
    body = text;
  } else if (result.toolResult !== undefined) {
    // The legacy shape (see `McpCallResult`). The condition is "no text came out of content",
    // deliberately NOT "content is absent": measured against the real SDK with a real legacy
    // server, `callTool`'s default result schema **defaults `content` to `[]`** and passes
    // `toolResult` through alongside it, so the response arrives as
    // `{"content":[],"toolResult":"..."}`. Keying off an absent `content` therefore never fired,
    // and the result was reported as empty - which is how the integration test caught it.
    body = typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
  } else {
    body = '[the tool returned no content]';
  }

  return result.isError === true ? `The tool reported an error: ${body}` : body;
}

/**
 * What the approval path is told about a proxied tool.
 *
 * Note what is and is not here. `autoApprove` comes from the user's config and is allowed to
 * change a verdict; everything else is the server describing itself, and is carried so the confirm
 * dialog can *show* it. `endpoint` is set only for a remote server, since "this call leaves your
 * machine, to this host" is the fact most worth having in front of you before you press Yes - and
 * for a local one there is nothing to name.
 */
export function provenanceOf(server: McpServerConfig, descriptor: McpToolDescriptor): McpToolProvenance {
  const reach = reachOf(server);
  let endpoint: string | undefined;
  if (reach === 'remote' && server.url) {
    try {
      endpoint = new URL(server.url).host;
    } catch {
      endpoint = server.url;
    }
  }
  return {
    serverId: server.id,
    serverToolName: descriptor.name,
    reach,
    endpoint,
    annotations: descriptor.annotations,
    hintsTrusted: server.grants.trustReadOnlyHints,
    autoApprove: server.grants.autoApprove,
  };
}

/**
 * Wraps one server's advertised tools as `Tool`s.
 *
 * `inputSchema` passes straight through because MCP already speaks JSON Schema and so does our
 * `Tool` - the two agreed without a translation layer, which is most of why this integration is
 * as small as it is.
 */
export function proxyTools(
  server: McpServerConfig,
  descriptors: readonly McpToolDescriptor[],
  call: McpToolCaller,
): Tool[] {
  return descriptors.map((descriptor) => ({
    name: mcpToolName(server.id, descriptor.name),
    // The server id is in the description as well as the name: the name tells the model which
    // tool, this tells it whose, which matters when two servers expose similar tools.
    description: `[via MCP server "${server.id}"] ${descriptor.description ?? descriptor.annotations?.title ?? descriptor.name}`,
    inputSchema: descriptor.inputSchema,
    mutating: isMutating(server, descriptor),
    mcp: provenanceOf(server, descriptor),
    execute: async (input: Record<string, unknown>): Promise<string> => {
      try {
        return flattenToolResult(await call(descriptor.name, input));
      } catch (error) {
        // A transport failure, a timeout, or a dead server. The loop gets a string it can show
        // the model and carry on with; it must never take the turn down.
        const message = error instanceof Error ? error.message : String(error);
        return `The MCP server "${server.id}" could not run ${descriptor.name}: ${message}`;
      }
    },
  }));
}
