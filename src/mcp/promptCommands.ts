import type { CommandInfo, McpPromptRef } from '../ui/slashCommand.js';
import type { McpServerConfig } from './serverConfig.js';

/**
 * Turning an MCP server's **prompts** into `/`-invokable commands.
 *
 * This answers design doc §5.6's open question - "does an MCP server's exposed tools
 * automatically become `/`-invokable commands, or stay purely LLM-invoked" - and the answer is
 * neither half of how it was posed: **tools stay model-invoked, and prompts become the slash
 * commands.** That is not a preference, it is what the primitives are for
 * (`docs/docs/2026-07-28/learn/server-concepts.mdx`):
 *
 * > "Tools are model-controlled, meaning AI models can discover and invoke them automatically."
 *
 * > "Prompts are user-controlled, requiring explicit invocation rather than automatic
 * > triggering. ... Applications typically expose prompts through various UI patterns such as:
 * > **Slash commands** (typing "/" to see available prompts like /plan-vacation)"
 *
 * So the spec describes exactly this feature, for exactly this primitive. Exposing *tools* as
 * slash commands would also have put a typed command on the wrong side of the approval gate -
 * either double-confirming something the user just typed, or quietly treating the typing as the
 * confirmation - which is a question this design never has to answer.
 *
 * Everything here is pure: the server talking happens in `client.ts`.
 */

/** The parts of an MCP prompt descriptor this layer uses, read off the installed `1.32.1`
 * typings (`client/index.d.ts`'s `listPrompts()` return) rather than assumed, and declared
 * locally for the same reason `McpToolDescriptor` is - so tests can build one by hand. */
export interface McpPromptDescriptor {
  name: string;
  description?: string;
  title?: string;
  arguments?: readonly { name: string; description?: string; required?: boolean }[];
}

/** One message of a `prompts/get` result, as much of it as this layer reads. */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: { type: string; text?: string };
}

/** What `prompts/get` returns. */
export interface McpPromptResult {
  description?: string;
  messages: readonly McpPromptMessage[];
}

/**
 * What a prompt name becomes inside a command name.
 *
 * Lowercased and reduced to `[a-z0-9-]`, because a command name has to be **typable**: the
 * unknown-command check in `App.tsx` compares `commandName(input)` exactly, so a prompt called
 * `planVacation` would otherwise only answer to `/mcp-x-planVacation` typed with that exact
 * casing, and one with a space in it would never be reachable at all (`commandName` splits on
 * whitespace). The server-side name is kept verbatim alongside, in `McpPromptRef.promptName`,
 * and that is what goes on the wire.
 */
export function slugForCommand(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `/mcp-<server>-<prompt>`. The `/mcp-` prefix is what keeps these in their own family. */
export function mcpPromptCommandName(serverId: string, promptName: string): string {
  return `/mcp-${serverId}-${slugForCommand(promptName)}`;
}

/** A server's prompts, as handed to `buildPromptCommands`. */
export interface McpPromptSource {
  readonly config: McpServerConfig;
  readonly prompts: readonly McpPromptDescriptor[];
}

export interface BuiltPromptCommands {
  readonly commands: readonly CommandInfo[];
  /** One per prompt that could not be registered, for the same "say so by name" treatment
   * `startup.ts` gives a server that would not start. */
  readonly problems: readonly string[];
}

/**
 * How long a `name - description` row may be before it stops fitting the dropdown.
 *
 * This project's picker rule is that a row wraps to at most three lines at 100 columns, and
 * `pickerRows.test.ts` enforces it over every built-in command. A prompt description comes from
 * a server, so it cannot simply be trusted to be short - one long line of marketing copy would
 * push the input box off the screen.
 *
 * 200 was measured against the real wrapper rather than derived: the three lines hold 94 + 92 + 92
 * cells, but word wrapping never fills them, and `wrapRow` hard-chunks a token that cannot break
 * at all - so an unbreakable 200-character run is what sets this ceiling, not prose. The test that
 * pins it wraps the row with the dropdown's own helper, which is what makes the number checkable
 * instead of magic.
 */
const MAX_ROW_CHARS = 200;

/** Clips to `max` characters, marking that it was clipped. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function usageFor(name: string, args: McpPromptRef['arguments']): string {
  if (args.length === 0) return '';
  if (args.length === 1) {
    const arg = args[0];
    return ` Usage: ${name} <${arg.name}>`;
  }
  return ` Usage: ${name} ${args.map((a) => `${a.name}=<value>`).join(' ')}`;
}

/**
 * Builds the command rows for every granted server's prompts.
 *
 * Two kinds of name clash are **refused and reported** rather than resolved by precedence:
 *
 * - **A built-in command's name or alias.** Structurally this cannot happen today, since every
 *   generated name starts `/mcp-<id>-` and no built-in does - but it is checked anyway, because
 *   the invariant that matters is "a server can never redefine a command the user already
 *   relies on", and that must not quietly depend on nobody ever adding a built-in `/mcp-*`.
 * - **Another generated name.** Two prompts whose slugs collide (`My Prompt` and `my-prompt`)
 *   get neither registered, because silently shadowing one with the other would mean the user
 *   runs something other than what they read in the list.
 */
export function buildPromptCommands(
  sources: readonly McpPromptSource[],
  builtInNames: readonly string[],
): BuiltPromptCommands {
  const builtIn = new Set(builtInNames.map((n) => n.toLowerCase()));
  const commands: CommandInfo[] = [];
  const problems: string[] = [];
  // Which generated name came from which prompt, so a collision can name both sides.
  const seen = new Map<string, { serverId: string; promptName: string }>();
  const collided = new Set<string>();

  for (const source of sources) {
    for (const prompt of source.prompts) {
      const serverId = source.config.id;
      const slug = slugForCommand(prompt.name);
      if (!slug) {
        problems.push(
          `MCP server "${serverId}": prompt "${prompt.name}" has no name that can be typed as a command - not registered.`,
        );
        continue;
      }
      const name = mcpPromptCommandName(serverId, prompt.name);
      if (builtIn.has(name.toLowerCase())) {
        problems.push(
          `MCP server "${serverId}": prompt "${prompt.name}" would override the built-in ${name} - not registered. A server never replaces a built-in command.`,
        );
        continue;
      }
      const previous = seen.get(name);
      if (previous) {
        collided.add(name);
        problems.push(
          `MCP server "${serverId}": prompt "${prompt.name}" and "${previous.promptName}" (server "${previous.serverId}") both become ${name} - neither is registered, so neither can be run by mistake.`,
        );
        continue;
      }
      seen.set(name, { serverId, promptName: prompt.name });

      const args = (prompt.arguments ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required === true,
      }));
      const ref: McpPromptRef = { serverId, promptName: prompt.name, arguments: args };
      const described = prompt.description ?? prompt.title ?? `Prompt "${prompt.name}" from MCP server "${serverId}".`;
      // Clipped twice on purpose. The first keeps the usage line visible, since that is the part
      // the user needs in order to run the thing; the second is the backstop for a server whose
      // own argument names are long enough to blow the budget on their own.
      const usage = usageFor(name, args);
      const room = MAX_ROW_CHARS - `${name} - `.length;
      const head = clip(described, Math.max(20, room - usage.length));
      // A server's description does not have to end in punctuation, and without this the row
      // read "Review one file Usage: ..." - found by running it, not by reading it. Matches how
      // the built-in rows do it (`...(shown in /resume). Usage: /set-sessionname <name>`). The
      // ellipsis counts as terminal so a clipped description does not come back as "....".
      const sep = usage && !/[.!?:…]$/.test(head) ? '.' : '';
      const description = clip(`${head}${sep}${usage}`, room);
      commands.push({
        name,
        // Hidden for the same reason every `/set-*` is: a server with twenty prompts must not
        // flood the bare "/" palette. Still typable by exact name, and listed by `/mcp`'s own
        // family picker, which is how a hidden command is meant to be found.
        hidden: true,
        // No arguments means there is nothing for the user to type, so Enter runs it. With
        // arguments, Enter prefills `/name ` and the user finishes the line.
        select: args.length === 0 ? 'run' : 'prefill',
        description,
        mcpPrompt: ref,
      });
    }
  }

  // A collision takes out the row that got there first as well - `seen` has it, `commands` has
  // it, and only now is it known to be ambiguous.
  return {
    commands: commands.filter((c) => !collided.has(c.name)),
    problems,
  };
}

export interface FlattenedPrompt {
  /** The text to put in front of the user. Empty when the prompt carried no text at all. */
  readonly text: string;
  /** What was in the result but could not be represented, so it is said out loud rather than
   * dropped in silence. */
  readonly notes: readonly string[];
}

/**
 * Flattens a `prompts/get` result into the one block of text that goes into the input box.
 *
 * Lossy in two ways, both reported rather than hidden:
 *
 * - **Assistant messages.** A prompt may seed a whole exchange; the input box is one user turn,
 *   so pre-filled assistant turns cannot be represented. Their text is still shown, labelled,
 *   because a template that reads as a dialogue is still useful to a person - but the fact that
 *   o4c is not replaying it as a real assistant turn is said.
 * - **Non-text content.** Images and embedded resources are counted, not silently skipped: a
 *   prompt whose point was the attached image must not expand to a confident-looking half.
 */
export function flattenPromptMessages(result: McpPromptResult): FlattenedPrompt {
  const parts: string[] = [];
  const notes: string[] = [];
  let assistantCount = 0;
  const skipped = new Map<string, number>();

  for (const message of result.messages) {
    const { type, text } = message.content;
    if (type === 'text' && typeof text === 'string') {
      if (message.role === 'assistant') {
        assistantCount += 1;
        parts.push(`[assistant, from the prompt template]\n${text}`);
      } else {
        parts.push(text);
      }
      continue;
    }
    skipped.set(type, (skipped.get(type) ?? 0) + 1);
  }

  if (assistantCount > 0) {
    notes.push(
      `This prompt supplied ${assistantCount} assistant turn${assistantCount === 1 ? '' : 's'}, kept as labelled text - o4c does not replay them as real assistant turns.`,
    );
  }
  for (const [type, count] of skipped) {
    notes.push(`${count} ${type} part${count === 1 ? '' : 's'} of this prompt could not be put into the input box.`);
  }

  return { text: parts.join('\n\n'), notes };
}
