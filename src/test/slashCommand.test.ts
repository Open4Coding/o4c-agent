import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeSlashCommand,
  commandName,
  isComposingCommand,
  matchCommands,
  commandForHelpTarget,
  KNOWN_COMMANDS,
  COMMANDS,
  setCommands,
  commandFamily,
  knownCommandNames,
  parsePromptArguments,
  type McpPromptRef,
} from '../ui/slashCommand.js';

test('recognizes a bare slash command', () => {
  assert.equal(looksLikeSlashCommand('/clear'), true);
  assert.equal(looksLikeSlashCommand('/nonexistent'), true);
});

test('does not treat a pasted Unix path as a slash command', () => {
  assert.equal(looksLikeSlashCommand('/Users/x/file.md'), false);
  assert.equal(looksLikeSlashCommand('/usr/local/bin/node --version'), false);
});

test('checks only the first word, so a path later in the message is not mistaken for a command', () => {
  assert.equal(looksLikeSlashCommand('what does /etc/hosts do?'), false);
});

test('non-slash input is never a command', () => {
  assert.equal(looksLikeSlashCommand('hello'), false);
  assert.equal(looksLikeSlashCommand(''), false);
});

test('commandName extracts just the /word, ignoring anything after whitespace', () => {
  assert.equal(commandName('/clear'), '/clear');
  assert.equal(commandName('/foo bar baz'), '/foo');
});

test('KNOWN_COMMANDS matches the commands actually handled in App.tsx - /help is real now, /debug still is not', () => {
  assert.deepEqual(KNOWN_COMMANDS, [
    '/clear',
    '/resume',
    '/context',
    '/ctx',
    '/plans',
    '/keyboard',
    '/keyboard-windows',
    '/keyboard-mac',
    '/keyboard-linux',
    '/mode',
    '/think',
    '/window',
    '/datagraph',
    '/colorview',
    '/help',
    '/exit',
    '/quit',
    '/set',
    '/set-sessionname',
    '/set-sessionsToSave',
    '/set-local-sessionsToSave',
    '/set-global-sessionsToSave',
    '/set-sessionview',
    '/set-local-sessionview',
    '/set-global-sessionview',
    '/set-think',
    '/set-local-think',
    '/set-global-think',
    '/config',
    '/config-highlightcolor',
    '/config-local-highlightcolor',
    '/config-global-highlightcolor',
    '/mcp',
  ]);
});

test('isComposingCommand is true for a bare "/" or a partial command name, false once a space is typed', () => {
  assert.equal(isComposingCommand('/'), true);
  assert.equal(isComposingCommand('/re'), true);
  assert.equal(isComposingCommand('/resume'), true);
  assert.equal(isComposingCommand('/resume '), false);
  assert.equal(isComposingCommand('/resume foo'), false);
  assert.equal(isComposingCommand('hello'), false);
  assert.equal(isComposingCommand('/usr/local/bin/node'), false);
});

test('matchCommands filters by prefix (name or alias) case-insensitively, sorted alphabetically', () => {
  const matches = matchCommands('/c');
  assert.deepEqual(matches.map((c) => c.name), ['/clear', '/colorview', '/config', '/context']);
});

test('matchCommands matches on an alias even when the canonical name does not start with the prefix', () => {
  const matches = matchCommands('/ctx');
  assert.deepEqual(matches.map((c) => c.name), ['/context']);
});

test('matchCommands with a bare "/" returns every non-hidden command, alphabetically ascending by canonical name', () => {
  const names = matchCommands('/').map((c) => c.name);
  const expected = COMMANDS.filter((c) => !c.hidden)
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, expected);
});

test('matchCommands never returns a hidden command, even when its own name is typed as the prefix', () => {
  // /set-sessionname is hidden - discoverable via /set's own picker, not the main palette, even
  // once the prefix narrows down to exactly it.
  assert.deepEqual(matchCommands('/set-sessionname'), []);
});

test('matchCommands returns nothing for a prefix no command matches', () => {
  assert.deepEqual(matchCommands('/zzz'), []);
});

test('commandForHelpTarget resolves a canonical name, an alias, and a hidden command by exact name', () => {
  assert.equal(commandForHelpTarget('mode')?.name, '/mode');
  assert.equal(commandForHelpTarget('ctx')?.name, '/context'); // alias
  assert.equal(commandForHelpTarget('set-sessionname')?.name, '/set-sessionname'); // hidden
});

test('commandForHelpTarget returns undefined for a name nothing registers', () => {
  assert.equal(commandForHelpTarget('bogus'), undefined);
});

test('the three /set-*sessionview commands are registered, hidden, reachable through /set, and listed by /help', () => {
  const names = ['/set-sessionview', '/set-local-sessionview', '/set-global-sessionview'];
  for (const name of names) {
    const cmd = COMMANDS.find((c) => c.name === name);
    assert.ok(cmd, name + ' is registered');
    assert.equal(cmd!.hidden, true, name + ' is hidden from the bare "/" list');
    assert.equal(cmd!.select, 'run', name + ' takes no typed argument, so choosing it runs it');
    assert.ok(setCommands().some((c) => c.name === name), name + ' appears in the /set picker');
    assert.equal(commandForHelpTarget(name.slice(1))?.name, name, name + ' resolves for /help-<name>');
  }
  assert.equal(matchCommands('/set-sess').some((c) => names.includes(c.name)), false);
});

/**
 * `parsePromptArguments` - the typed tail of an MCP prompt command.
 *
 * Lives in this module rather than in `src/mcp/` because what it parses is command-line text, and
 * both of its inputs (the ref, the rest of the line) are this layer's own.
 */

const ONE_REQUIRED: McpPromptRef = {
  serverId: 'fixture',
  promptName: 'review',
  arguments: [{ name: 'path', required: true }],
};
const TWO: McpPromptRef = {
  serverId: 'fixture',
  promptName: 'diff',
  arguments: [{ name: 'left', required: true }, { name: 'right', required: false }],
};
const NONE: McpPromptRef = { serverId: 'fixture', promptName: 'summarize', arguments: [] };

test('a single argument takes the whole rest of the line, spaces and all', () => {
  // The only form that can carry a value with a space in it, since there is no quoting here.
  const parsed = parsePromptArguments(ONE_REQUIRED, '  src/my dir/App.tsx  ');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args, { path: 'src/my dir/App.tsx' });
});

test('key=value wins over the whole-line form as soon as an = appears', () => {
  const parsed = parsePromptArguments(ONE_REQUIRED, 'path=src/a.ts');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args, { path: 'src/a.ts' });
});

test('several arguments are read as key=value pairs', () => {
  const parsed = parsePromptArguments(TWO, 'left=a.ts right=b.ts');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args, { left: 'a.ts', right: 'b.ts' });
});

test('an optional argument may be left out', () => {
  const parsed = parsePromptArguments(TWO, 'left=a.ts');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args, { left: 'a.ts' });
});

test('a missing required argument is refused by name', () => {
  const parsed = parsePromptArguments(ONE_REQUIRED, '');
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /needs an argument: path/);
});

test('a typo in a key is refused rather than passed through as an absent argument', () => {
  // The failure this prevents: the server expands the prompt wrongly instead of not at all.
  const parsed = parsePromptArguments(TWO, 'lefft=a.ts');
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /no argument "lefft"/);
  assert.match(parsed.error, /It takes: left, right/);
});

test('an unparseable pair says what the shape should be', () => {
  const parsed = parsePromptArguments(TWO, 'a.ts b.ts');
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /left=<value> right=<value>/);
});

test('a prompt that takes nothing refuses arguments, with its own wording', () => {
  // Checked before the key=value branch, which would otherwise produce a usage line listing
  // nothing at all.
  const parsed = parsePromptArguments(NONE, 'unexpected');
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /takes no arguments, so "unexpected" was not used/);
});

test('a prompt that takes nothing accepts an empty tail', () => {
  const parsed = parsePromptArguments(NONE, '   ');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args, {});
});

test('knownCommandNames adds the dynamic rows to the built-ins without replacing them', () => {
  const extra = [{ name: '/mcp-fixture-review', description: 'x' }];
  const all = knownCommandNames(extra);
  assert.ok(all.includes('/exit'), 'built-ins still there');
  assert.ok(all.includes('/mcp-fixture-review'), 'dynamic row there');
  // KNOWN_COMMANDS itself stays the built-in list - it is what buildPromptCommands checks against.
  assert.ok(!KNOWN_COMMANDS.includes('/mcp-fixture-review'));
});

test('a dynamic row joins its family picker but not the bare palette', () => {
  const extra = [{ name: '/mcp-fixture-review', description: 'x', hidden: true }];
  assert.deepEqual(
    commandFamily('/mcp', extra).map((c) => c.name),
    ['/mcp', '/mcp-fixture-review'],
  );
  // Hidden, so the bare "/" listing is unaffected - same treatment as every /set-*.
  assert.ok(!matchCommands('/', extra).some((c) => c.name === '/mcp-fixture-review'));
});

test('/help-<dynamic row> resolves, because it is an exact-name lookup', () => {
  const extra = [{ name: '/mcp-fixture-review', description: 'Review one file', hidden: true }];
  assert.equal(commandForHelpTarget('mcp-fixture-review', extra)?.description, 'Review one file');
});
