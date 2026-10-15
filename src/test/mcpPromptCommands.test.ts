import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServers, type McpServerConfig } from '../mcp/serverConfig.js';
import {
  buildPromptCommands,
  flattenPromptMessages,
  mcpPromptCommandName,
  slugForCommand,
  type McpPromptDescriptor,
} from '../mcp/promptCommands.js';
import { KNOWN_COMMANDS } from '../ui/slashCommand.js';
import { wrapRow } from '../ui/SelectList.js';

/** The dropdown's own wrapping, at the same 100-column widths `pickerRows.test.ts` pins. */
function wrappedLines(text: string): number {
  return wrapRow(text, 94, 92).length;
}

/**
 * Turning a server's prompts into command rows.
 *
 * The rules worth pinning are all about what a server is NOT allowed to do to the command
 * surface: shadow a built-in, shadow another server, or register a name that cannot be typed.
 */

function configure(raw: Record<string, unknown>): readonly McpServerConfig[] {
  const { servers, problems } = parseServers(raw);
  assert.deepEqual(problems, [], 'fixture config must be valid');
  return servers;
}

const GRANTED = { transport: 'stdio', command: 'node', args: ['s.js'], grants: { slashCommands: true } };

function source(id: string, prompts: McpPromptDescriptor[]): { config: McpServerConfig; prompts: McpPromptDescriptor[] } {
  const [config] = configure({ [id]: GRANTED });
  return { config, prompts };
}

test('a prompt becomes /mcp-<server>-<prompt>, described by its own description', () => {
  const { commands, problems } = buildPromptCommands(
    [source('fixture', [{ name: 'summarize', description: 'Summarize the work so far' }])],
    KNOWN_COMMANDS,
  );
  assert.deepEqual(problems, []);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, '/mcp-fixture-summarize');
  assert.match(commands[0].description, /^Summarize the work so far/);
  assert.deepEqual(commands[0].mcpPrompt, { serverId: 'fixture', promptName: 'summarize', arguments: [] });
  // Hidden like every narrow command, so twenty prompts cannot flood the bare "/" palette - still
  // typable by exact name, and listed by /mcp's own family picker.
  assert.equal(commands[0].hidden, true);
  // Nothing to type, so Enter runs it.
  assert.equal(commands[0].select, 'run');
});

test('a prompt with arguments prefills instead of running, and says how to call it', () => {
  const { commands } = buildPromptCommands(
    [
      source('fixture', [
        { name: 'review', description: 'Review one file', arguments: [{ name: 'path', required: true }] },
      ]),
    ],
    KNOWN_COMMANDS,
  );
  assert.equal(commands[0].select, 'prefill');
  assert.match(commands[0].description, /Usage: \/mcp-fixture-review <path>/);
  // The server's description need not end in punctuation; without a separator the row read
  // "Review one file Usage: ...". Same shape as the built-in rows.
  assert.equal(commands[0].description, 'Review one file. Usage: /mcp-fixture-review <path>');
});

test('a description that already ends in punctuation does not get a second full stop', () => {
  const { commands } = buildPromptCommands(
    [
      source('fixture', [
        { name: 'review', description: 'Review one file.', arguments: [{ name: 'path', required: true }] },
      ]),
    ],
    KNOWN_COMMANDS,
  );
  assert.equal(commands[0].description, 'Review one file. Usage: /mcp-fixture-review <path>');
});

test('two arguments produce the key=value usage line, since only that form can carry both', () => {
  const { commands } = buildPromptCommands(
    [
      source('fixture', [
        {
          name: 'diff',
          description: 'Compare two files',
          arguments: [{ name: 'left', required: true }, { name: 'right', required: true }],
        },
      ]),
    ],
    KNOWN_COMMANDS,
  );
  assert.match(commands[0].description, /Usage: \/mcp-fixture-diff left=<value> right=<value>/);
});

test('a prompt name that is not typable as a command is slugged, with the real name kept for the wire', () => {
  assert.equal(slugForCommand('Review File'), 'review-file');
  assert.equal(slugForCommand('planVacation'), 'planvacation');
  assert.equal(slugForCommand('--odd--name--'), 'odd-name');
  assert.equal(mcpPromptCommandName('x', 'Review File'), '/mcp-x-review-file');

  const { commands } = buildPromptCommands([source('fixture', [{ name: 'Review File' }])], KNOWN_COMMANDS);
  assert.equal(commands[0].name, '/mcp-fixture-review-file');
  // The slug is for typing; the server is still asked for the name it actually published.
  assert.equal(commands[0].mcpPrompt?.promptName, 'Review File');
});

test('a prompt whose name slugs to nothing is refused by name rather than registered unreachable', () => {
  const { commands, problems } = buildPromptCommands([source('fixture', [{ name: '???' }])], KNOWN_COMMANDS);
  assert.deepEqual(commands, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /prompt "\?\?\?" has no name that can be typed as a command/);
});

test('a server can never register a name a built-in already uses', () => {
  // Structurally impossible through `mcpPromptCommandName` today, since every generated name
  // starts `/mcp-<id>-`; checked anyway, because the invariant must not depend on nobody ever
  // adding a built-in `/mcp-*`. Simulated by handing in a built-in list that contains the name
  // this prompt would generate.
  const { commands, problems } = buildPromptCommands(
    [source('fixture', [{ name: 'status' }])],
    [...KNOWN_COMMANDS, '/mcp-fixture-status'],
  );
  assert.deepEqual(commands, []);
  assert.match(problems[0], /would override the built-in \/mcp-fixture-status - not registered/);
  assert.match(problems[0], /never replaces a built-in command/);
});

test('two prompts that slug to the same command register neither, and both are named', () => {
  const { commands, problems } = buildPromptCommands(
    [source('fixture', [{ name: 'My Prompt' }, { name: 'my-prompt' }])],
    KNOWN_COMMANDS,
  );
  // Not "first wins": the user would read one description and run the other.
  assert.deepEqual(commands, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"my-prompt" and "My Prompt"/);
  assert.match(problems[0], /neither is registered/);
});

test('the same prompt name on two different servers is not a collision', () => {
  const { commands, problems } = buildPromptCommands(
    [source('alpha', [{ name: 'review' }]), source('beta', [{ name: 'review' }])],
    KNOWN_COMMANDS,
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(
    commands.map((c) => c.name),
    ['/mcp-alpha-review', '/mcp-beta-review'],
  );
});

test('a prompt with no description still gets one, naming its server', () => {
  const { commands } = buildPromptCommands([source('fixture', [{ name: 'bare' }])], KNOWN_COMMANDS);
  assert.match(commands[0].description, /Prompt "bare" from MCP server "fixture"/);
});

test('a title is used when there is no description, since it is the next most useful thing', () => {
  const { commands } = buildPromptCommands(
    [source('fixture', [{ name: 'bare', title: 'A titled prompt' }])],
    KNOWN_COMMANDS,
  );
  assert.match(commands[0].description, /^A titled prompt/);
});

test('flattening joins the user text of a single-message prompt with no notes', () => {
  const flat = flattenPromptMessages({
    messages: [{ role: 'user', content: { type: 'text', text: 'Review src/a.ts' } }],
  });
  assert.equal(flat.text, 'Review src/a.ts');
  assert.deepEqual(flat.notes, []);
});

test('an assistant turn is kept as labelled text and said out loud, not silently replayed', () => {
  const flat = flattenPromptMessages({
    messages: [
      { role: 'user', content: { type: 'text', text: 'the user half' } },
      { role: 'assistant', content: { type: 'text', text: 'the assistant half' } },
    ],
  });
  assert.match(flat.text, /the user half/);
  assert.match(flat.text, /\[assistant, from the prompt template\]\nthe assistant half/);
  assert.equal(flat.notes.length, 1);
  assert.match(flat.notes[0], /supplied 1 assistant turn, kept as labelled text/);
  assert.match(flat.notes[0], /does not replay them as real assistant turns/);
});

test('non-text parts are counted in a note, never dropped in silence', () => {
  const flat = flattenPromptMessages({
    messages: [
      { role: 'user', content: { type: 'text', text: 'look at this' } },
      { role: 'user', content: { type: 'image' } },
      { role: 'user', content: { type: 'image' } },
      { role: 'user', content: { type: 'resource' } },
    ],
  });
  assert.equal(flat.text, 'look at this');
  // A prompt whose point was the attachment must not expand to a confident-looking half.
  assert.deepEqual(
    [...flat.notes].sort(),
    [
      '1 resource part of this prompt could not be put into the input box.',
      '2 image parts of this prompt could not be put into the input box.',
    ].sort(),
  );
});

test('a prompt carrying no text at all flattens to empty, for the caller to refuse', () => {
  const flat = flattenPromptMessages({ messages: [{ role: 'user', content: { type: 'image' } }] });
  assert.equal(flat.text, '');
  assert.equal(flat.notes.length, 1);
});

test("a server's own description cannot blow the dropdown's three-line budget", () => {
  // The row text is the server's, so it is clipped rather than trusted. Checked with the real
  // wrapping helper the dropdown uses, at the same width pickerRows.test.ts pins for built-ins.
  const long = 'A prompt that describes itself at very great length. '.repeat(20);
  const { commands } = buildPromptCommands(
    [
      source('fixture', [
        {
          name: 'verbose',
          description: long,
          arguments: [{ name: 'path', required: true }],
        },
      ]),
    ],
    KNOWN_COMMANDS,
  );
  const row = `${commands[0].name} - ${commands[0].description}`;
  assert.ok(row.length < long.length, 'it was clipped');
  assert.ok(wrappedLines(row) <= 3, `row wraps to ${wrappedLines(row)} lines`);
  // The usage half survives, because that is the part needed in order to run it.
  assert.match(commands[0].description, /Usage: \/mcp-fixture-verbose <path>$/);
  assert.match(commands[0].description, /…/);
});

test('an absurd argument list is clipped too, rather than being exempt', () => {
  const args = Array.from({ length: 40 }, (_, i) => ({ name: `argument_number_${i}`, required: false }));
  const { commands } = buildPromptCommands(
    [source('fixture', [{ name: 'wide', description: 'Short enough', arguments: args }])],
    KNOWN_COMMANDS,
  );
  const row = `${commands[0].name} - ${commands[0].description}`;
  assert.ok(wrappedLines(row) <= 3, `row wraps to ${wrappedLines(row)} lines`);
});

