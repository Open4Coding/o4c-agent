import type { Tool } from '../tools/types.js';

export function makeFakeTool(
  name: string,
  result: string,
): Tool & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const tool: Tool & { calls: typeof calls } = {
    name,
    description: `Fake tool "${name}" for testing.`,
    inputSchema: { type: 'object', properties: {} },
    calls,
    async execute(input) {
      calls.push(input);
      return result;
    },
  };
  return tool;
}
