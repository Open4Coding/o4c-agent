/**
 * What an MCP server said about one of its tools, and where that tool runs.
 *
 * Carried on the `Tool` itself rather than looked up from the host, so the two places that need it
 * - the mode policy and the confirmation dialog - stay pure functions of the tool in front of
 * them. Declared here, beside `Tool`, so neither `src/ui/` nor `src/tools/` has to import from
 * `src/mcp/` to read it.
 *
 * **Every field except `autoApprove` is a claim by a third party**, which is the whole reason this
 * type exists: the spec says of `ToolAnnotations` that "all properties ... are hints ... should not
 * be relied upon for security decisions ... received from untrusted servers". So these are for the
 * user to read in the confirm dialog, and only `autoApprove` - which comes from the user's own
 * config - is allowed to change a decision.
 */
export interface McpToolProvenance {
  /** The server's config id, i.e. the `<id>` in `mcp__<id>__<tool>`. */
  readonly serverId: string;
  /** The name the server itself knows this tool by, before namespacing. */
  readonly serverToolName: string;
  /** Whether calling it leaves this machine. `reachOf` in `src/mcp/serverConfig.ts` decides. */
  readonly reach: 'local' | 'remote';
  /** For a remote server, the host the call goes to - worth seeing before approving one. */
  readonly endpoint?: string;
  /** The server's own `ToolAnnotations`, verbatim and unjudged. */
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  /** Whether the user granted `trustReadOnlyHints` for this server - i.e. whether the hint above
   * was allowed to set `mutating`. Displayed so an unprompted read-only tool is explicable. */
  readonly hintsTrusted: boolean;
  /** The one field here that may change a verdict: `grants.autoApprove`, set by the user, which
   * turns a `confirm` into an `allow` and never touches a `deny`. */
  readonly autoApprove: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** True for tools that change files/system state (write_file, run_shell) - the mode system
   * (src/ui/modePolicy.ts) uses this to decide whether a tool call needs confirmation or should
   * be blocked outright, without needing a hardcoded tool-name list. Read-only tools leave this
   * unset. */
  readonly mutating?: boolean;
  /** Set only on a tool proxied from an MCP server; absent on every built-in. Its presence is
   * also the honest answer to "is this ours?" wherever that matters. */
  readonly mcp?: McpToolProvenance;
  execute(input: Record<string, unknown>): Promise<string>;
}
