import Anthropic from '@anthropic-ai/sdk';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
  StopReason,
  ToolCall,
} from './types.js';

export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const blocks: Array<
        Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam
      > = [];
      // A thinking (or redacted_thinking) block must be the *first* content block in the turn
      // that produced it, and must round-trip back exactly as received - required by the API
      // once a thinking turn is followed by tool use, which every multi-round tool-calling turn
      // in this harness is. See Message.thinkingSignature's own doc comment for the full
      // reasoning; this is what actually replays it, not just parses it on the way in.
      if (msg.redactedThinking) {
        blocks.push({ type: 'redacted_thinking', data: msg.redactedThinking });
      } else if (msg.thinkingSignature && msg.thinkingText) {
        blocks.push({ type: 'thinking', thinking: msg.thinkingText, signature: msg.thinkingSignature });
      }
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      result.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'tool') {
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? '',
            content: msg.content,
          },
        ],
      });
    }
  }

  return result;
}

function mapStopReason(reason: string | null): StopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

// Matches LocalProvider's own DEFAULT_TIMEOUT_MS exactly, for the same reason: an explicit,
// intentional bound in this codebase rather than an implicit one inherited from a dependency.
// The Anthropic SDK does already have its own real default (confirmed directly,
// `node_modules/@anthropic-ai/sdk/index.js`: `Anthropic.DEFAULT_TIMEOUT = 600000` / 10 minutes),
// so this was never actually unbounded - but 10 minutes of a frozen "Thinking..." with no
// user-facing explanation is a long time to wait before the one existing backstop (request.signal,
// only set when the user manually presses Escape/Ctrl+C) is the only other way out.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_MAX_TOKENS = 4096;
// Current Claude 5 models reject `thinking.type.enabled`/`budget_tokens` outright (confirmed via
// a live 400: `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"
// and "output_config.effort" to control thinking behavior.`). Adaptive mode has no fixed token
// budget of its own - the model decides how much to think - so the extra headroom below is a
// flat allowance rather than a budget-derived one.
const THINKING_MAX_TOKENS_HEADROOM = 4096;

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;
  /** Opt-in, off by default - extended thinking has a real token-cost impact (thinking tokens are
   * billed as output), so this is never silently turned on. When set, `complete()` requests
   * `thinking: {type: 'adaptive', display: 'summarized'}` plus `output_config: {effort}` and
   * correctly threads the resulting signature/redacted-data back through `Message`/`ContextEntry`
   * so multi-round tool use (the normal case in this harness) keeps working - see
   * `toAnthropicMessages()`'s own reasoning for why that replay isn't optional once thinking is on. */
  private thinkingEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  // Was a flat 4096 (+4096 more when thinking was on) regardless of the model's real context size -
  // same latent bug as LocalProvider's own flat cap (see its own doc comment). Set from
  // config.json's contextWindow (cli.ts), not guessed here.
  private maxTokens: number;

  constructor(options: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    thinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxTokens?: number;
  } = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment.',
      );
    }
    this.client = new Anthropic({ apiKey, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.model = options.model ?? 'claude-opus-5';
    this.thinkingEffort = options.thinkingEffort;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Always requested via the SDK's streaming helper (`.stream()`, not `.create()`) - the only
    // change from the non-streaming form is that `onToken` (when given) sees text as it arrives
    // instead of only once the full message lands. `finalMessage()` still resolves to the exact
    // same `Anthropic.Message` shape `.create()` used to return, so everything below this point
    // is unchanged.
    const stream = this.client.messages.stream(
      {
        model: this.model,
        // Adaptive thinking has no fixed budget to size max_tokens against - flat extra headroom
        // on top of the configured cap instead, so a thinking-heavy response doesn't get cut off
        // mid-thought.
        max_tokens: this.thinkingEffort ? this.maxTokens + THINKING_MAX_TOKENS_HEADROOM : this.maxTokens,
        system: request.systemPrompt,
        messages: toAnthropicMessages(request.messages),
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...(this.thinkingEffort
          ? {
              thinking: { type: 'adaptive' as const, display: 'summarized' as const },
              output_config: { effort: this.thinkingEffort },
            }
          : {}),
      },
      { signal: request.signal },
    );
    if (request.onToken) {
      stream.on('text', (delta) => request.onToken?.(delta));
      // Same live-preview treatment as regular text - real-time think/response labeling isn't
      // attempted here either (AgentLoop's own `createThinkTagStripper` already made that call
      // for every provider, not just this one).
      stream.on('thinking', (delta) => request.onToken?.(delta));
    }

    let response: Anthropic.Message;
    try {
      response = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        const timeoutMs = this.client.timeout;
        throw new Error(
          `Anthropic did not respond within ${Math.round(timeoutMs / 1000)}s - try again, or check anthropic.com's status page.`,
        );
      }
      throw err;
    }

    let content = '';
    let thinking = '';
    let thinkingSignature: string | undefined;
    let redactedThinking: string | undefined;
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      } else if (block.type === 'thinking') {
        thinking += block.thinking;
        thinkingSignature = block.signature;
      } else if (block.type === 'redacted_thinking') {
        redactedThinking = block.data;
      }
    }

    // Reassembled into the same `<think>...</think>` convention every other provider already
    // produces - splitThinkBlock()/AgentLoop need no changes to handle a provider whose thinking
    // arrives as structured content blocks instead of inline tags. The signature/redacted-data
    // travel separately (below), for the exact replay toAnthropicMessages() needs later.
    const fullContent = thinking ? `<think>${thinking}</think>${content}` : content;

    return {
      content: fullContent,
      toolCalls,
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      thinkingSignature,
      redactedThinking,
    };
  }
}
