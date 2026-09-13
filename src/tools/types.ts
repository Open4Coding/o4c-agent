export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** True for tools that change files/system state (write_file, run_shell) - the mode system
   * (src/ui/modePolicy.ts) uses this to decide whether a tool call needs confirmation or should
   * be blocked outright, without needing a hardcoded tool-name list. Read-only tools leave this
   * unset. */
  readonly mutating?: boolean;
  execute(input: Record<string, unknown>): Promise<string>;
}
