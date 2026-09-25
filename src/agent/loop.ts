import type { LLMProvider, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
}

export interface RunOptions {
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
  images?: string[];
  /** Called before executing each tool call - lets the caller (App.tsx, via the mode system in
   * src/ui/modePolicy.ts) allow or deny it. Omitted entirely, every tool call runs unconditionally
   * (existing callers/tests keep working exactly as before). */
  toolPolicy?: (tool: Tool, input: Record<string, unknown>) => Promise<'allow' | 'deny'>;
  /** Lets the caller cancel this turn before the provider responds (e.g. the user pressed
   * Escape while the "Thinking..." spinner was showing). On abort, `run()` throws
   * `AbortedError` and rolls back everything this call appended to history, as if the turn had
   * never been sent. */
  signal?: AbortSignal;
}

/** Thrown when the loop exhausts its iteration budget without the model reaching a final answer. */
export class MaxIterationsError extends Error {
  constructor(public readonly maxIterations: number) {
    super(`stopped after ${maxIterations} iterations without a final answer`);
    this.name = 'MaxIterationsError';
  }
}

/** Thrown when `options.signal` is aborted mid-turn. Carries the original prompt back so the
 * caller (App.tsx) can restore it into the input box unchanged - conversation history for this
 * turn is rolled back in `run()` before this is thrown, as if the turn had never been sent. */
export class AbortedError extends Error {
  constructor(public readonly prompt: string) {
    super('turn cancelled by the user');
    this.name = 'AbortedError';
  }
}

export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  /** Number of completion requests actually sent to the provider, not turns or tool calls. */
  requestCount: number;
}

export class AgentLoop {
  private messages: Message[] = [];
  private usage: CumulativeUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };

  constructor(
    private provider: LLMProvider,
    private tools: Tool[],
    private systemPrompt: string,
  ) {}

  /** Clears conversation history and cumulative usage, starting a fresh session on the next `run()`. */
  reset(): void {
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  /** Raw conversation history so far - every message, tool call, and tool result. For debug/inspection UIs. */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** Token usage accumulated across every provider request this session, as reported by the provider - not estimated (except MockProvider, which has no real tokenizer to ask). */
  getUsage(): Readonly<CumulativeUsage> {
    return this.usage;
  }

  /**
   * Replaces in-memory history with a previously-saved session's messages (for /resume).
   * Cumulative usage resets to zero - it tracks this process's own request activity, not a
   * lifetime total for the session, so there's nothing real to restore it to.
   */
  loadMessages(messages: readonly Message[]): void {
    this.messages = [...messages];
    this.usage = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  }

  async run(userMessage: string, options: RunOptions = {}): Promise<string> {
    const maxIterations = options.maxIterations ?? 25;
    const onEvent = options.onEvent ?? (() => {});
    const messages = this.messages;
    // Saved so an abort mid-turn can roll history back to exactly this point - see the catch
    // block below.
    const lengthBeforeTurn = messages.length;
    messages.push({ role: 'user', content: userMessage, images: options.images });
    const toolDefs = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    for (let i = 0; i < maxIterations; i++) {
      let response;
      try {
        response = await this.provider.complete({
          systemPrompt: this.systemPrompt,
          messages,
          tools: toolDefs,
          signal: options.signal,
        });
      } catch (err) {
        // Checked on the caller's own signal, not the error's name/type - a provider may wrap
        // or rename the underlying abort error (e.g. LocalProvider merges this signal with its
        // own request timeout via AbortSignal.any, so a plain `err.name` check can't tell "the
        // user cancelled" apart from "the provider's own timeout fired" the way this can).
        if (options.signal?.aborted) {
          messages.length = lengthBeforeTurn;
          throw new AbortedError(userMessage);
        }
        throw err;
      }

      this.usage.requestCount += 1;
      if (response.usage) {
        this.usage.inputTokens += response.usage.inputTokens;
        this.usage.outputTokens += response.usage.outputTokens;
      }

      if (response.content) {
        onEvent({ type: 'text', text: response.content });
      }

      const isToolUse = response.stopReason === 'tool_use' && response.toolCalls.length > 0;
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: isToolUse ? response.toolCalls : undefined,
      });

      if (!isToolUse) {
        return response.content;
      }

      for (const call of response.toolCalls) {
        onEvent({ type: 'tool_call', toolName: call.name, toolInput: call.input });
        const tool = this.tools.find((t) => t.name === call.name);
        let output: string;
        if (!tool) {
          output = `Error: no tool registered with name "${call.name}"`;
        } else if (options.toolPolicy && (await options.toolPolicy(tool, call.input)) === 'deny') {
          output = `Blocked by the current mode: ${call.name} was not executed.`;
        } else {
          output = await tool.execute(call.input);
        }
        onEvent({ type: 'tool_result', toolName: call.name, toolOutput: output });
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }
    }

    throw new MaxIterationsError(maxIterations);
  }
}
