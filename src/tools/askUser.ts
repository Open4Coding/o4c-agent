import type { Tool } from './types.js';

/**
 * `ask_user` (plan 0006 C7): one question to the user, when the model genuinely cannot go on
 * without an answer - which of two designs, a name, a credential it must not guess. Optional
 * choices become a dropdown; a free-text answer is always possible.
 *
 * The tool knows nothing about the screen: the TUI registers a handler. With none (one-shot, eval,
 * scripts) the model is told nobody can answer, so it decides and says what it assumed rather
 * than stopping.
 */
export type AskUserHandler = (question: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;

let handler: AskUserHandler | undefined;

export function setAskUserHandler(next: AskUserHandler | undefined): void {
  handler = next;
}

export const askUserTool: Tool = {
  name: 'ask_user',
  description:
    'Ask the user one question you cannot answer yourself (a choice between designs, a missing value) - not to confirm work you can do. Optional "options" are offered as choices; the user may also type an answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One clear question.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Short answers to choose from.' },
    },
    required: ['question'],
  },
  async execute(input, context) {
    const question = String(input.question ?? '').trim();
    if (!question) return 'Error: ask_user needs a "question".';
    const options = Array.isArray(input.options) ? input.options.map(String).filter((o) => o.trim()).slice(0, 9) : [];
    if (!handler) {
      return 'No user is available to answer (this is a non-interactive run). Decide yourself, and say in your final answer what you assumed.';
    }
    const answer = await handler(question, options, context?.signal);
    if (answer === undefined || !answer.trim()) return 'The user did not answer. Decide yourself, and say what you assumed.';
    return `The user answered: ${answer.trim()}`;
  },
};
