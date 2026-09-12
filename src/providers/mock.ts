import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from './types.js';

/**
 * A free, zero-network, zero-API-key provider for developing/testing the
 * harness without spending real money on the Anthropic API. Not a model
 * simulator - just enough deterministic behavior to exercise the real
 * agent loop and real tool execution end to end.
 */
// Not a real tokenizer - mock has no model to ask, so this is a crude chars/4 estimate purely so
// /context has something to show when testing with --provider mock. Never treated as accurate.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const inputChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
    const hasToolResult = request.messages.some((m) => m.role === 'tool');

    if (!hasToolResult && request.tools.length > 0) {
      const tool = request.tools[0];
      const call: ToolCall = {
        id: 'mock-call-1',
        name: tool.name,
        input: placeholderInput(tool),
      };
      const content = `[mock] calling "${tool.name}" to see what happens.`;
      return {
        content,
        toolCalls: [call],
        stopReason: 'tool_use',
        usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: estimateTokens(content) },
      };
    }

    const lastTool = [...request.messages].reverse().find((m) => m.role === 'tool');
    const summary = lastTool
      ? `[mock] ran a tool and got ${lastTool.content.length} characters back.`
      : '[mock] no tools were available to call.';

    const content = `${summary} This is a canned mock response, not a real answer - use --provider anthropic for that.`;
    return {
      content,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: estimateTokens(String(inputChars)), outputTokens: estimateTokens(content) },
    };
  }
}

function placeholderInput(tool: ToolDefinition): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string }> };
  const props = schema.properties ?? {};
  const input: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    switch (def.type) {
      case 'number':
      case 'integer':
        input[key] = 0;
        break;
      case 'boolean':
        input[key] = false;
        break;
      case 'object':
        input[key] = {};
        break;
      case 'array':
        input[key] = [];
        break;
      default:
        input[key] = '';
    }
  }
  return input;
}
