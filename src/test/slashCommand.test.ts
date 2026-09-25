import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeSlashCommand,
  commandName,
  isComposingCommand,
  matchCommands,
  KNOWN_COMMANDS,
  COMMANDS,
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

test('KNOWN_COMMANDS matches the commands actually handled in App.tsx - no /help, no /debug', () => {
  assert.deepEqual(KNOWN_COMMANDS, [
    '/clear',
    '/resume',
    '/wipe',
    '/context',
    '/ctx',
    '/keyboardcommands',
    '/mode',
    '/exit',
    '/quit',
    '/set',
    '/set-sessionname',
    '/config',
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
  assert.deepEqual(matches.map((c) => c.name), ['/clear', '/config', '/context']);
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
